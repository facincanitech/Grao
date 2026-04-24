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
    const { plano } = await req.json()
    const jwt = req.headers.get('Authorization')!.replace('Bearer ', '')
    const b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const payload = JSON.parse(atob(b64))
    const userId = payload.user_metadata?.provider_id
    if (!userId) throw new Error('Usuário não autenticado')

    const VALORES: Record<string, string> = { mensal_10: '10.00', bimestral_18: '18.00', trimestral_25: '25.00' }
    const valor = VALORES[plano]
    if (!valor) throw new Error('Plano inválido: ' + plano)

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
        transaction_amount: parseFloat(valor),
        payment_method_id: 'pix',
        payer: { email: `user-${userId}@graonet.app` },
        description: `VIP GrãoNet - ${plano}`,
        external_reference: `vip:${userId}:${plano}`,
        notification_url: `${supabaseUrl}/functions/v1/webhook-pix?secret=${webhookSecret}`,
      })
    })

    const mpData = await mpRes.json()
    if (!mpData.id) throw new Error('MP Error: ' + JSON.stringify(mpData))

    const txid = String(mpData.id)
    const qrCode = 'data:image/png;base64,' + (mpData.point_of_interaction?.transaction_data?.qr_code_base64 || '')
    const copiaCola = mpData.point_of_interaction?.transaction_data?.qr_code

    const supabase = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    await supabase.from('pagamentos_pix').insert({
      txid,
      user_id: userId,
      valor: parseFloat(valor),
      plano,
      status: 'pendente'
    })

    return new Response(JSON.stringify({ txid, qrcode: qrCode, copia_e_cola: copiaCola }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
    })
  }
})
