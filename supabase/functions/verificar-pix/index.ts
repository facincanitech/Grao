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
    const { txid, tipo } = await req.json() // tipo: 'vip' ou 'p2p'

    const clientId     = Deno.env.get('EFI_CLIENT_ID')!
    const clientSecret = Deno.env.get('EFI_CLIENT_SECRET')!
    const certPemB64   = Deno.env.get('EFI_CERT_PEM_B64')!
    const keyPemB64    = Deno.env.get('EFI_KEY_PEM_B64')!

    const certPem = new TextDecoder().decode(Uint8Array.from(atob(certPemB64.replace(/\s/g,'')), c => c.charCodeAt(0)))
    const keyPem  = new TextDecoder().decode(Uint8Array.from(atob(keyPemB64.replace(/\s/g,'')), c => c.charCodeAt(0)))

    // @ts-ignore
    const httpClient = Deno.createHttpClient({ certChain: certPem, privateKey: keyPem })

    // 1. Autenticar
    const authRes = await fetch('https://pix.api.efipay.com.br/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${clientId}:${clientSecret}`),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ grant_type: 'client_credentials' }),
      // @ts-ignore
      client: httpClient,
    })
    const { access_token } = await authRes.json()
    if (!access_token) throw new Error('Falha na autenticação Efí')

    // 2. Consultar cobrança
    const cobRes = await fetch(`https://pix.api.efipay.com.br/v2/cob/${txid}`, {
      headers: { 'Authorization': `Bearer ${access_token}` },
      // @ts-ignore
      client: httpClient,
    })
    const cob = await cobRes.json()

    // Status CONCLUIDA = pago
    if (cob.status !== 'CONCLUIDA') {
      return new Response(JSON.stringify({ pago: false, status: cob.status }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 3. Processar pagamento
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    if (tipo === 'vip') {
      const { data: payment } = await supabase.from('pagamentos_pix').select('*').eq('txid', txid).single()
      if (!payment || payment.status === 'concluida') {
        return new Response(JSON.stringify({ pago: true, processado: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      await supabase.from('pagamentos_pix').update({ status: 'concluida' }).eq('txid', txid)
      const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
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

    return new Response(JSON.stringify({ pago: true, processado: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400
    })
  }
})
