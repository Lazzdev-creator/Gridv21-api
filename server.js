import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function slugify(text) {
  return text.toString().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w-]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function scaleContent(tool) {
  const base = tool.name;
  return [
    `Best ${base} Alternatives for Contractors in 2026`,
    `How to Use ${base} to Get More Leads`,
    `${base} vs Competitors: Contractor Guide`,
    `${base} Pricing: Is It Worth It for Small Business?`
  ];
}

function generateSEO(tool) {
  return `Compare ${tool.name} for ${tool.type} leads. Get pricing, features, and contractor reviews. Updated 2026.`;
}

async function getConfig() {
  const { data } = await db.from('config').select('*').eq('id', 1).single();
  return data || { click_weight: 1.0, conversion_weight: 3.0, boost_threshold: 15 };
}

// 1. Track clicks
app.get('/api/track/:slug', async (req, res) => {
  const { slug } = req.params;
  const { data: tool } = await db.from('tools').select('id, clicks').eq('slug', slug).single();
  if (tool) {
    await db.from('tools').update({ clicks: tool.clicks + 1 }).eq('id', tool.id);
    await db.from('click_events').insert({ tool_id: tool.id });
  }
  res.json({ ok: true });
});

// 2. Track leads/conversions
app.post('/api/lead', async (req, res) => {
  const { tool_slug, email, phone, message } = req.body;
  const { data: tool } = await db.from('tools').select('id, conversions').eq('slug', tool_slug).single();
  if (tool) {
    await db.from('tools').update({ conversions: tool.conversions + 1 }).eq('id', tool.id);
    await db.from('leads').insert({ tool_id: tool.id, email, phone, message });
  }
  res.json({ ok: true });
});

// 3. BRAIN: Cron hits this hourly - auto publishes
app.post('/internal/run-cycle', async (req, res) => {
  if (req.headers['x-cron-key'] !== process.env.CRON_KEY) return res.status(401).end();
  
  const config = await getConfig();
  const { data: tools } = await db.from('tools').select('*');
  const { data: overrides } = await db.from('overrides').select('*');
  
  let publishedCount = 0;
  for (const tool of tools) {
    const override = overrides.find(o => o.tool_id === tool.id);
    const score = tool.clicks * config.click_weight + tool.conversions * config.conversion_weight;
    
    if (override?.force_boost === false) continue;
    
    if (override?.force_boost === true || score > config.boost_threshold) {
      const drafts = scaleContent(tool).map(title => ({
        tool_id: tool.id,
        title,
        slug: slugify(title),
        meta_description: generateSEO(tool),
        status: 'auto_published',
        score: score,
        published_at: new Date()
      }));
      
      await db.from('posts').upsert(drafts, { onConflict: 'slug' });
      await db.from('tools').update({ last_boosted_at: new Date() }).eq('id', tool.id);
      publishedCount++;
    }
  }
  res.json({ auto_published: publishedCount });
});

// 4. Self-aware: Adjust weights weekly
app.post('/internal/adjust-weights', async (req, res) => {
  if (req.headers['x-cron-key'] !== process.env.CRON_KEY) return res.status(401).end();
  
  const { data: contractorRevenue } = await db.from('tools')
    .select('conversions')
    .eq('type', 'contractor_lead')
    .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  
  const { data: aiRevenue } = await db.from('tools')
    .select('conversions')
    .eq('type', 'ai_tool')
    .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString());
  
  const contractorTotal = contractorRevenue.reduce((sum, t) => sum + t.conversions, 0) * 150;
  const aiTotal = aiRevenue.reduce((sum, t) => sum + t.conversions, 0) * 5;
  
  let newConversionWeight = 3.0;
  if (contractorTotal > aiTotal * 1.5) newConversionWeight = 5.0;
  if (aiTotal > contractorTotal * 1.5) newConversionWeight = 1.5;
  
  await db.from('config').update({ 
    conversion_weight: newConversionWeight,
    last_adjusted: new Date()
  }).eq('id', 1);
  
  res.json({ new_weight: newConversionWeight, contractor_rev: contractorTotal, ai_rev: aiTotal });
});

// 5. Public API
app.get('/api/posts', async (req, res) => {
  const { data } = await db.from('posts')
    .select('title, slug, meta_description, published_at, tools(name, type)')
    .eq('status', 'auto_published')
    .order('published_at', { ascending: false })
    .limit(50);
  res.json(data);
});

app.get('/api/leads/count', async (req, res) => {
  const { count: totalLeads } = await db.from('leads').select('*', { count: 'exact', head: true });
  const { data: contractorLeads } = await db.from('leads')
    .select('id, tools(type)')
    .eq('tools.type', 'contractor_lead');
  
  const contractorCount = contractorLeads?.length || 0;
  const aiCount = (totalLeads || 0) - contractorCount;
  const estimatedRevenue = contractorCount * 150 + aiCount * 5;
  
  res.json({ total_leads: totalLeads, contractor_leads: contractorCount, ai_leads: aiCount, estimated_revenue: estimatedRevenue });
});

// 6. ADMIN DASHBOARD API
app.get('/admin/dashboard', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  
  const { data: posts } = await db.from('posts')
    .select('*, tools(name, type, clicks, conversions)')
    .eq('status', 'auto_published')
    .order('published_at', { ascending: false })
    .limit(50);
  
  const { data: overrides } = await db.from('overrides').select('*');
  res.json({ live_posts: posts || [], your_overrides: overrides || [] });
});

app.post('/admin/unpublish/:id', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  await db.from('posts').update({ status: 'archived' }).eq('id', req.params.id);
  res.json({ ok: true });
});

app.post('/admin/override', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  const { tool_id, force_boost, notes } = req.body;
  await db.from('overrides').upsert({ tool_id, force_boost, notes }, { onConflict: 'tool_id' });
  res.json({ ok: true });
});

app.post('/admin/edit/:id', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  await db.from('posts').update({ 
    title: req.body.title, 
    meta_description: req.body.meta,
    human_edited: true 
  }).eq('id', req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
