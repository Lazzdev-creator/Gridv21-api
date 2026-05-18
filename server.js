import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase client
const db = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'GridBrain API running' });
});

// Get all active tools for dashboard
app.get('/api/tools', async (req, res) => {
  const { data, error } = await db
    .from('tools')
    .select('id, name, slug, status, clicks, affiliate_url, amazon_asin')
    .eq('status', 'active')
    .order('clicks', { ascending: false });
  
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Get tool by slug
app.get('/api/tools/:slug', async (req, res) => {
  const { slug } = req.params;
  const { data, error } = await db
    .from('tools')
    .select('*')
    .eq('slug', slug)
    .single();
  
  if (error) return res.status(404).json({ error: 'Tool not found' });
  res.json(data);
});

// Track click and redirect to Amazon
app.get('/api/track/:slug', async (req, res) => {
  const { slug } = req.params;
  
  try {
    const { data: tool, error } = await db
      .from('tools')
      .select('id, clicks, affiliate_url')
      .eq('slug', slug)
      .single();
    
    if (error || !tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    
    if (!tool.affiliate_url) {
      return res.status(400).json({ error: 'No affiliate link set for this tool' });
    }
    
    // Increment click count
    await db.from('tools')
      .update({ clicks: (tool.clicks || 0) + 1 })
      .eq('id', tool.id);
    
    // Log click event for analytics
    await db.from('click_events')
      .insert({ tool_id: tool.id, clicked_at: new Date().toISOString() })
      .select();
    
    // Build Amazon URL with tracking
    const url = new URL(tool.affiliate_url);
    url.searchParams.set('tag', 'gridbrain08-20');
    url.searchParams.set('subid', `tool_${tool.id}`);
    
    return res.redirect(302, url.toString());
    
  } catch (err) {
    console.error('Track error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// Get revenue from conversions
app.get('/api/revenue', async (req, res) => {
  const { data, error } = await db
    .from('conversions')
    .select('commission, status')
    .eq('status', 'confirmed');
  
  if (error) return res.status(500).json({ error: error.message });
  
  const total = data.reduce((sum, r) => sum + parseFloat(r.commission || 0), 0);
  res.json({ total_revenue: total.toFixed(2), count: data.length });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
