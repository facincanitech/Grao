// deno-lint-ignore-file
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { txid, tipo } = await req.json()

    const accessToken = Deno.env.get('MP_ACCESS_TOKEN')!

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${txid}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    })
    const mpData = await mpRes.json()

    if (mpData.status !== 'approved') {
      return new Response(JSON.stringify({ pago: false, status: mpData.status }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    if (tipo === 'vip') {
      const { data: payment } = await supabase.from('pagamentos_pix').select('*').eq('txid', txid).single()
      if (!payment || payment.status === 'concluida') {
        return new Response(JSON.stringify({ pago: true, processado: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      await supabase.from('pagamentos_pix').update({ status: 'concluida' }).eq('txid', txid)
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
    }

    if (tipo === 'p2p') {
      const { data: listing } = await supabase.from('market_listings_brl').select('*').eq('txid', txid).single()
      if (!listing || listing.status === 'sold') {
        return new Response(JSON.stringify({ pago: true, processado: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      await supabase.rpc('process_p2p_liquidation', { target_txid: txid })
      await supabase.channel('global').send({
        type: 'broadcast', event: 'p2p_sale_confirmed',
        payload: { listingId: listing.id, grainId: listing.grain_id, sellerId: listing.seller_id, buyerId: listing.buyer_id }
      })
    }

    if (tipo === 'deposito') {
      const { data: payment } = await supabase.from('pagamentos_pix').select('*').eq('txid', txid).single()
      if (!payment || payment.status === 'concluida') {
        return new Response(JSON.stringify({ pago: true, processado: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      await supabase.from('pagamentos_pix').update({ status: 'concluida' }).eq('txid', txid)
      await supabase.rpc('add_real_balance', { target_user_id: payment.user_id, amount: payment.valor })
    }

    return new Response(JSON.stringify({ pago: true, processado: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400
    })
  }
})
