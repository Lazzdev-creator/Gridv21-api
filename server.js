require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,https://iatjgyrphrxeqaiqbpfb.supabase.co/rest/v1/
  process.env.SUPABASE_SERVICE_KEY
);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: "ok", service: "Gridv21 API v1" });
});

// Get permits
app.get('/v1/permits', async (req, res) => {
  const { city, limit = 50 } = req.query;
  
  let query = supabase.from('permits').select('*').limit(limit);
  if (city) query = query.ilike('city', city);
  
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  
  res.json({ count: data.length, data });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Gridv21 live on ${PORT}`));
