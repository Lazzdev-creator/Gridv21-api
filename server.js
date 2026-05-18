const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'gridv21-api' });
});

// Test route - check if DB is connected
app.get('/api/process-tools', async (req, res) => {
  try {
    const { data: tools, error } = await supabase
      .from('tools')
      .select('id, name, slug, amazon_asin')
      .limit(5);

    if (error) {
      return res.status(500).json({ success: false, message: error.message });
    }

    if (!tools || tools.length === 0) {
      return res.json({ success: false, message: 'No tools to process' });
    }

    res.json({ success: true, count: tools.length, tools });

  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Affiliate redirect route
app.get('/api/track/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: tool, error } = await supabase
      .from('tools')
      .select('id, amazon_asin')
      .eq('slug', slug)
      .single();

    if (error || !tool || !tool.amazon_asin) {
      return res.status(404).send('Tool not found or no ASIN set');
    }

    const redirectUrl = `https://www.amazon.com/dp/${tool.amazon_asin}/?tag=gridbrain08-20&subid=tool_${tool.id}`;
    return res.redirect(302, redirectUrl);
    
  } catch (err) {
    console.error('Track error:', err);
    res.status(500).send('Server error');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
