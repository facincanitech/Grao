// deno-lint-ignore-file
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

serve(async (req: Request) => {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  const expectedSecret = Deno.env.get('WEBHOOK_SECRET')

  if (!expectedSecret || secret !== expectedSecret) {
    return new Response('unauthorized', { status: 401 })
  }

  try {
    const body = await req.json()

    // MP envia: { action: "payment.updated", data: { id: "123456" } }
    if (body.type !== 'payment' || !body.data?.id) {
      return new Response('ok: ignored', { status: 200 })
    }

    const paymentId = String(body.data.id)
    const accessToken = Deno.env.get('MP_ACCESS_TOKEN')!

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    })
    const mpData = await mpRes.json()

    if (mpData.status !== 'approved') {
      return new Response('ok: not approved', { status: 200 })
    }

    const txid = paymentId
    const externalRef: string = mpData.external_reference || ''

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // VIP ou Depósito — busca em pagamentos_pix
    const { data: payment } = await supabase
      .from('pagamentos_pix')
      .select('*')
      .eq('txid', txid)
      .single()

    if (payment && payment.status === 'pendente') {
      await supabase.from('pagamentos_pix').update({ status: 'concluida' }).eq('txid', txid)

      if (payment.plano === 'deposito') {
        await supabase.rpc('add_real_balance', { target_user_id: payment.user_id, amount: payment.valor })
        return new Response('ok: deposito', { status: 200 })
      }

      // VIP
      const DIAS: Record<string, number> = { mensal_10: 30, bimestral_18: 60, trimestral_25: 90 }
      const dias = DIAS[payment.plano] || 30
      const future = new Date(Date.now() + dias * 24 * 60 * 60 * 1000)
      await supabase.from('users').update({
        is_vip: true,
        vip_glow_color: 'purple',
        premium_until: future.toISOString()
      }).eq('discord_id', payment.user_id)
      await supabase.channel('global').send({
        type: 'broadcast', event: 'vip_activated', payload: { userId: payment.user_id }
      })
      return new Response('ok: vip', { status: 200 })
    }

    // P2P — busca em market_listings_brl
    const { data: listing } = await supabase
      .from('market_listings_brl')
      .select('*')
      .eq('txid', txid)
      .eq('status', 'pending_payment')
      .single()

    if (listing) {
      await supabase.rpc('process_p2p_liquidation', { target_txid: txid })
      await supabase.channel('global').send({
        type: 'broadcast', event: 'p2p_sale_confirmed',
        payload: {
          listingId: listing.id,
          grainId: listing.grain_id,
          sellerId: listing.seller_id,
          buyerId: listing.buyer_id,
          amount: Number(listing.price) * 0.90
        }
      })
      return new Response('ok: p2p', { status: 200 })
    }

    return new Response('ok: no action', { status: 200 })
  } catch (error: any) {
    console.error(error)
    return new Response(error.message, { status: 400 })
  }
})
