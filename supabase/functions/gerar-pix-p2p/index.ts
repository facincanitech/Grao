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
    const { buyerId, buyerName, listingId } = await req.json()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // 1. Buscar detalhes da listagem
    const { data: listing, error: errListing } = await supabase
      .from('market_listings_brl')
      .select('*')
      .eq('id', listingId)
      .eq('status', 'active')
      .single()

    if (!listing || errListing) {
      throw new Error("Item não disponível ou já reservado.")
    }

    if (listing.seller_id === buyerId) {
      throw new Error("Você não pode comprar seu próprio item.")
    }

    // 2. Preparar Efí
    const clientId = Deno.env.get('EFI_CLIENT_ID')
    const clientSecret = Deno.env.get('EFI_CLIENT_SECRET')
    const certBase64 = Deno.env.get('EFI_CERT_BASE64')
    
    if (!clientId || !clientSecret || !certBase64) {
      throw new Error("Missing Efí credentials in environment variables.")
    }
    
    const certPem = atob(certBase64)
    // @ts-ignore
    const httpClient = Deno.createHttpClient({
      certChain: certPem,
      privateKey: certPem,
    })

    const authRes = await fetch("https://api-pix.efipay.com.br/oauth/token", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ grant_type: "client_credentials" }),
      // @ts-ignore
      client: httpClient,
    })
    
    const { access_token } = await authRes.json()

    // 3. Gerar Pix
    const txid = crypto.randomUUID().replace(/-/g, '')
    const cobRes = await fetch(`https://api-pix.efipay.com.br/v2/cob/${txid}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        calendario: { expiracao: 1800 }, // 30 min para P2P
        valor: { original: listing.price.toFixed(2) },
        chave: Deno.env.get('EFI_PIX_KEY'),
        solicitacaoPagador: `GrãoNet: ${listing.grain_id}`
      }),
      // @ts-ignore
      client: httpClient,
    })

    const cobData = await cobRes.json()
    if (!cobData.loc) {
      throw new Error("Efí API Error: " + JSON.stringify(cobData))
    }
    const locId = cobData.loc.id

    const qrRes = await fetch(`https://api-pix.efipay.com.br/v2/loc/${locId}/qrcode`, {
      headers: { "Authorization": `Bearer ${access_token}` },
      // @ts-ignore
      client: httpClient,
    })
    const qrData = await qrRes.json()

    // 4. Reservar o item
    await supabase.from('market_listings_brl').update({
      txid: txid,
      buyer_id: buyerId,
      buyer_name: buyerName,
      status: 'pending_payment'
    }).eq('id', listingId)

    return new Response(JSON.stringify({
      qrcode: qrData.imagemQrcode,
      copia_e_cola: qrData.qrcode
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
