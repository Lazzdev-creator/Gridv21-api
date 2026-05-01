const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Enable CORS for your GitHub Pages site
app.use(cors());
app.use(express.json());

// Supabase connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// GET all permits with filters
app.get('/v1/permits', async (req, res) => {
  const { city, status } = req.query;
  let query = 'SELECT id, city, permit_type, status, issued_date FROM permits WHERE 1=1';
  const params = [];

  if (city) {
    params.push(`%${city}%`);
    query += ` AND city ILIKE $${params.length}`;
  }
  if (status) {
    params.push(status);
    query += ` AND status = $${params.length}`;
  }

  try {
    const result = await pool.query(query, params);
    res.json({ count: result.rows.length, data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST new permit
app.post('/v1/permits', async (req, res) => {
  const { city, permit_type, status, issued_date } = req.body;

  if (!city || !permit_type) {
    return res.status(400).json({ error: 'City and permit_type required' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO permits (city, permit_type, status, issued_date) VALUES ($1, $2, $3, $4) RETURNING id',
      [city, permit_type, status, issued_date]
    );
    res.json({ id: result.rows[0].id, message: 'Permit created' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`API running on port ${port}`);
});
