import express from 'express'
import cors from 'cors'
import { supabaseAdmin } from './lib/supabaseAdmin.js'

const app = express()
const PORT = process.env.PORT || 3000

app.set('trust proxy', true)

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }))
app.use(express.json())
app.use(express.static('public'))

// Auth middleware
const requireKey = (envVar) => (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.key
  if (key!== process.env[envVar]) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

const requireCronKey = requireKey('CRON_KEY')
const requireAdminKey = requireKey('ADMIN_KEY')

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Gridv21 Brain Online', timestamp: new Date().toISOString() })
})

// ===== DASHBOARD STATS ENDPOINT =====
app.get('/api/stats', async (req, res) => {
  try {
    const [{ count: total_leads }, { count: contractor_leads }, { count: ai_leads },
           { count: total_clicks }, { data: posts }, { data: tools }] = await Promise.all([
      supabaseAdmin.from('leads').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('leads').select('*', { count: 'exact', head: true }).eq('type', 'contractor'),
      supabaseAdmin.from('leads').select('*', { count: 'exact', head: true }).eq('type', 'ai'),
      supabaseAdmin.from('clicks').select('*', { count: 'exact', head: true }),
      supabaseAdmin.from('posts').select('*').eq('status', 'published'),
      supabaseAdmin.from('tools').select('name, id, conversions').order('id', { ascending: false }).limit(1)
    ])

    const estimated_revenue = (contractor_leads * 150) + (ai_leads * 5)
    const topTool = tools?.[0]?.name || '-'

    res.json({
      total_leads, contractor_leads, ai_leads,
      estimated_revenue, live_posts: posts.length,
      total_clicks: total_clicks || 0, top_tool: topTool
    })
  } catch (err) {
    console.error('Stats error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Get all live posts
app.get('/api/posts', async (req, res) => {
  const { data, error } = await supabaseAdmin
   .from('posts')
   .select('*, tools(*)')
   .eq('status', 'published')
   .order('published_at', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

// Redirect tracker using redirects table
app.get('/go/:slug', async (req, res) => {
  const { slug } = req.params
  try {
    const { data: redirect, error } = await supabaseAdmin
     .from('redirects')
     .select('target_url, id, description')
     .eq('slug', slug)
     .eq('active', true)
     .maybeSingle()

    if (error) {
      console.error('Redirect DB error:', error)
      return res.status(500).send('Database error')
    }
    if (!redirect?.target_url) {
      return res.status(404).send('Tool not found or no affiliate link')
    }
    res.redirect(301, redirect.target_url)
  } catch (err) {
    console.error('Redirect error:', err)
    res.status(500).send('Server error')
  }
})

// Affiliate redirect with click tracking
app.get('/api/track/:slug', async (req, res) => {
  const { slug } = req.params
  try {
    const { data: tool, error } = await supabaseAdmin
     .from('tools')
     .select('id, amazon_asin')
     .eq('slug', slug)
     .single()

    if (error ||!tool?.amazon_asin) {
      console.log(`Tool not found or no ASIN set for: ${slug}`)
      return res.status(404).send('Tool not found or no ASIN set')
    }

    await supabaseAdmin.from('clicks').insert({
      tool_id: tool.id, slug, ip: req.ip, user_agent: req.headers['user-agent']
    }).catch(e => console.log('Click log failed:', e.message))

    const redirectUrl = `https://www.amazon.com/dp/${tool.amazon_asin}/?tag=gridbrain08-20&subid=tool_${tool.id}`
    return res.redirect(302, redirectUrl)
  } catch (err) {
    console.error('Track error:', err)
    res.status(500).send('Server error')
  }
})

// Lead capture
app.post('/api/lead', async (req, res) => {
  const { name, email, phone, tool_slug, type } = req.body
  const { data: tool } = await supabaseAdmin
   .from('tools')
   .select('id')
   .eq('slug', tool_slug)
   .maybeSingle()

  const { data, error } = await supabaseAdmin
   .from('leads')
   .insert({ name, email, phone, tool_id: tool?.id, type: type || 'ai', status: 'new' })
   .select()
   .single()

  if (error) return res.status(500).json({ error: error.message })

  if (tool?.id) {
    await supabaseAdmin.rpc('increment_conversions', { tool_id: tool.id }).catch(() => {})
  }

  res.json({ success: true, lead_id: data.id })
})

// Admin dashboard data - removed limit so you see all 31 posts
app.get('/admin/dashboard', requireAdminKey, async (req, res) => {
  try {
    const [postsRes, leadsRes, clicksRes] = await Promise.all([
      supabaseAdmin.from('posts').select('*, tools(*)').eq('status', 'published')
       .order('published_at', { ascending: false }),
      supabaseAdmin.from('leads').select('*').order('created_at', { ascending: false }).limit(10),
      supabaseAdmin.from('clicks').select('*').order('created_at', { ascending: false }).limit(20)
    ])

    res.json({
      live_posts: postsRes.data || [],
      recent_leads: leadsRes.data || [],
      recent_clicks: clicksRes.data || []
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Lead counts for revenue calc
app.get('/api/leads/count', requireAdminKey, async (req, res) => {
  const [{ count: total_leads }, { count: contractor_leads }, { count: ai_leads }] = await Promise.all([
    supabaseAdmin.from('leads').select('*', { count: 'exact', head: true }),
    supabaseAdmin.from('leads').select('*', { count: 'exact', head: true }).eq('type', 'contractor'),
    supabaseAdmin.from('leads').select('*', { count: 'exact', head: true }).eq('type', 'ai')
  ])

  const estimated_revenue = (contractor_leads * 150) + (ai_leads * 5)
  res.json({ total_leads: total_leads || 0, contractor_leads: contractor_leads || 0, ai_leads: ai_leads || 0, estimated_revenue })
})

// Edit post
app.post('/admin/edit/:id', requireAdminKey, async (req, res) => {
  const { id } = req.params
  const { title, meta } = req.body
  const { error } = await supabaseAdmin
   .from('posts')
   .update({ title, meta_description: meta, updated_at: new Date() })
   .eq('id', id)

  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// Unpublish post
app.post('/admin/unpublish/:id', requireAdminKey, async (req, res) => {
  const { id } = req.params
  const { error } = await supabaseAdmin
   .from('posts')
   .update({ status: 'draft' })
   .eq('id', id)

  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// BRAIN: Hourly auto-publish cycle
app.get('/internal/run-cycle', requireCronKey, async (req, res) => {
  try {
    const { data: tools, error: toolsError } = await supabaseAdmin
     .from('tools')
     .select('*')
     .eq('status', 'active')
     .is('last_posted_at', null)
     .order('clicks', { ascending: false })
     .limit(1)

    if (toolsError) return res.status(500).json({ error: toolsError.message })
    if (!tools?.length) return res.json({ success: false, message: 'No tools to process' })

    const tool = tools[0]
    const slug = `best-${tool.slug}-${Date.now()}`
    const title = `Best ${tool.name} for Contractors in 2026 | Gridv21`
    const meta_description = `${tool.name} review: Features, pricing, and why contractors use it.`
    const body_md = `# ${tool.name} Review\n${tool.description || 'Top-rated tool for contractors.'}\n\n[Get ${tool.name} Here](/go/${tool.slug})`

    const { data: post, error: postError } = await supabaseAdmin
     .from('posts')
     .insert({ tool_id: tool.id, slug, title, meta_description, body_md, status: 'published', published_at: new Date() })
     .select()
     .single()

    if (postError) return res.status(500).json({ error: postError.message })

    await supabaseAdmin.from('tools').update({ last_posted_at: new Date() }).eq('id', tool.id)
    res.json({ success: true, posts_created: 1, tool_used: tool.name, post_slug: post.slug })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// BRAIN: Weekly self-optimize
app.get('/internal/tune-brain', requireCronKey, async (req, res) => {
  try {
    const { data: tools } = await supabaseAdmin.from('tools').select('*')
    for (const tool of tools || []) {
      const score = (tool.clicks || 0) + (tool.conversions || 0) * 3
      const status = score > 15? 'boost' : score < 3? 'pause' : 'active'
      await supabaseAdmin.from('tools').update({ performance_status: status }).eq('id', tool.id)
    }
    res.json({ success: true, tuned: tools?.length || 0 })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ===== AFFILIATE HQ ROUTES =====
app.get('/api/tools', async (req, res) => {
  const { data, error } = await supabaseAdmin
   .from('tools')
   .select('name, affiliate_link')
  if (error) return res.status(500).json({ error: error.message })
  res.json(data || [])
})

app.post('/api/affiliates/update-link', async (req, res) => {
  const { tool_name, affiliate_link } = req.body
  const { error } = await supabaseAdmin
   .from('tools')
   .update({ affiliate_link })
   .eq('name', tool_name)

  if (error) return res.status(500).json({ error: error.message })
  res.json({ success: true })
})

// ===== LIVE ACTIVITY FEED VIA SSE =====
app.get('/api/live-feed', requireAdminKey, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const { data: recentLeads } = await supabaseAdmin
   .from('leads')
   .select('id, name, email, type, created_at')
   .order('created_at', { ascending: false })
   .limit(10)

  res.write(`data: ${JSON.stringify({ type: 'init', data: recentLeads })}\n\n`)

  const channel = supabaseAdmin
   .channel('activity-feed')
   .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'leads' },
      payload => res.write(`data: ${JSON.stringify({ type: 'lead', data: payload.new })}\n\n`)
    )
   .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'clicks' },
      payload => res.write(`data: ${JSON.stringify({ type: 'click', data: payload.new })}\n\n`)
    )
   .subscribe()

  req.on('close', () => {
    supabaseAdmin.removeChannel(channel)
    res.end()
  })
})

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
