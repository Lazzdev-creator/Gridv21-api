const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'gridv21-api' });
});

// Affiliate redirect route
app.get('/api/track/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: tool, error } = await supabase
      .from('tools')
      .select('id, amazon_asin, name')
      .eq('slug', slug)
      .single();

    if (error) {
      console.error('Supabase error:', error.message);
      return res.status(500).send('Database error');
    }

    if (!tool || !tool.amazon_asin) {
      return res.status(404).send(`Tool not found or no ASIN set for: ${slug}`);
    }

    const redirectUrl = `https://www.amazon.com/dp/${tool.amazon_asin}/?tag=gridbrain08-20&subid=tool_${tool.id}`;
    
    console.log(`Redirecting ${slug} to ${redirectUrl}`);
    return res.redirect(302, redirectUrl);

  } catch (err) {
    console.error('Track error:', err);
    res.status(500).send('Server error');
  }
});

// Example: route to process tools if you need it
app.get('/api/process-tools', async (req, res) => {
  try {
    const { data: tools, error } = await supabase
      .from('tools')
      .select('id, name, amazon_asin')
      .is('amazon_asin', null);

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
