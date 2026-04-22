// deno-lint-ignore-file
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { userId, plano } = await req.json()
    const valor = plano === 'mensal_10' ? "10.00" : "30.00"

    const clientId = Deno.env.get('EFI_CLIENT_ID')
    const clientSecret = Deno.env.get('EFI_CLIENT_SECRET')
    const certBase64 = Deno.env.get('EFI_CERT_BASE64')
    
    if (!clientId || !clientSecret || !certBase64) {
      throw new Error("Missing Efí credentials in environment variables.")
    }
    
    const certPem = atob(certBase64)
    // @ts-ignore: Deno.createHttpClient is Deno-specific
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
      // @ts-ignore: client property is Deno-specific
      client: httpClient,
    })
    
    const { access_token } = await authRes.json()

    const txid = crypto.randomUUID().replace(/-/g, '')
    const cobRes = await fetch(`https://api-pix.efipay.com.br/v2/cob/${txid}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        calendario: { expiracao: 3600 },
        valor: { original: valor },
        chave: Deno.env.get('EFI_PIX_KEY'),
        solicitacaoPagador: "VIP GraoNet"
      }),
      // @ts-ignore: client property is Deno-specific
      client: httpClient,
    })

    const cobData = await cobRes.json()
    if (!cobData.loc) {
      throw new Error("Efí API Error: " + JSON.stringify(cobData))
    }
    const locId = cobData.loc.id

    const qrRes = await fetch(`https://api-pix.efipay.com.br/v2/loc/${locId}/qrcode`, {
      headers: { "Authorization": `Bearer ${access_token}` },
      // @ts-ignore: client property is Deno-specific
      client: httpClient,
    })
    const qrData = await qrRes.json()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    
    await supabase.from('pagamentos_pix').insert({
      txid: txid,
      user_id: userId,
      valor: parseFloat(valor),
      plano: plano,
      status: 'pendente'
    })

    return new Response(JSON.stringify({
      qrcode: qrData.imagemQrcode,
      copia_e_cola: qrData.qrcode
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    })
  }
})
