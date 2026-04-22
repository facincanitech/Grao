// deno-lint-ignore-file
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

serve(async (req: Request) => {
  try {
    const body = await req.json()
    
    const pix = body.pix?.[0]
    if (!pix) return new Response('no pix data', { status: 200 })

    const { txid } = pix
    
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // 1. Verificar se é Assinatura VIP
    const { data: payment } = await supabase
      .from('pagamentos_pix')
      .select('*')
      .eq('txid', txid)
      .single()

    if (payment && payment.status === 'pendente') {
      await supabase.from('pagamentos_pix').update({ status: 'concluida' }).eq('txid', txid)

      const now = new Date()
      const future = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000))

      await supabase.from('users').update({
        is_vip: true,
        vip_glow_color: 'purple',
        premium_until: future.toISOString()
      }).eq('discord_id', payment.user_id)

      await supabase.channel('global').send({
        type: 'broadcast',
        event: 'vip_activated',
        payload: { userId: payment.user_id }
      })
      return new Response('ok: vip', { status: 200 })
    }

    // 2. Verificar se é Venda P2P
    const { data: listing } = await supabase
      .from('market_listings_brl')
      .select('*')
      .eq('txid', txid)
      .eq('status', 'pending_payment')
      .single()

    if (listing) {
      // A. Transferir o item para o comprador
      const { error: errUpdateGrain } = await supabase
        .from('grains')
        .update({ 
          owner: listing.buyer_id, 
          lock_trade: false          
        })
        .eq('id', listing.grain_id)

      if (errUpdateGrain) throw errUpdateGrain

      // B. Marcar o anúncio como concluído
      await supabase
        .from('market_listings_brl')
        .update({ 
          status: 'sold',
          sold_at: new Date().toISOString()
        })
        .eq('id', listing.id)

      // C. Creditar o saldo ao vendedor (valor - taxa de 10%)
      const valorLiquido = Number(listing.price) * 0.90
      await supabase.rpc('increment_user_balance', { 
        uid: listing.seller_id, 
        amount: valorLiquido 
      })

      // D. Notificar via Realtime (opcional, mas bom para UX)
      await supabase.channel('global').send({
        type: 'broadcast',
        event: 'p2p_sale_confirmed',
        payload: { 
          listingId: listing.id,
          grainId: listing.grain_id,
          sellerId: listing.seller_id,
          buyerId: listing.buyer_id
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
