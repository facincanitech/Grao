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
    const { buyerName, listingId } = await req.json()
    const jwt = req.headers.get('Authorization')!.replace('Bearer ', '')
    const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(b64))
    const buyerId = payload.user_metadata?.provider_id
    if (!buyerId) throw new Error('Usuário não autenticado')

    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const { data: listing, error: errListing } = await supabase
      .from('market_listings_brl')
      .select('*')
      .eq('id', listingId)
      .eq('status', 'active')
      .single()

    if (!listing || errListing) throw new Error('Item não disponível ou já reservado.')
    if (listing.seller_id === buyerId) throw new Error('Você não pode comprar seu próprio item.')

    const accessToken = Deno.env.get('MP_ACCESS_TOKEN')!
    const webhookSecret = Deno.env.get('WEBHOOK_SECRET')!
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        transaction_amount: parseFloat(listing.price.toFixed(2)),
        payment_method_id: 'pix',
        payer: { email: `user-${buyerId}@graonet.app` },
        description: `GrãoNet P2P: ${listing.grain_id}`,
        external_reference: `p2p:${listingId}`,
        notification_url: `${supabaseUrl}/functions/v1/webhook-pix?secret=${webhookSecret}`,
      })
    })

    const mpData = await mpRes.json()
    if (!mpData.id) throw new Error('MP Error: ' + JSON.stringify(mpData))

    const txid = String(mpData.id)
    const qrCode = 'data:image/png;base64,' + (mpData.point_of_interaction?.transaction_data?.qr_code_base64 || '')
    const copiaCola = mpData.point_of_interaction?.transaction_data?.qr_code

    await supabase.from('market_listings_brl').update({
      txid,
      buyer_id: buyerId,
      buyer_name: buyerName,
      status: 'pending_payment'
    }).eq('id', listingId)

    return new Response(JSON.stringify({ txid, qrcode: qrCode, copia_e_cola: copiaCola }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    })
  }
})
