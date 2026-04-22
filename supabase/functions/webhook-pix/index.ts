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
    }

    return new Response('ok', { status: 200 })
  } catch (error: any) {
    console.error(error)
    return new Response(error.message, { status: 400 })
  }
})
