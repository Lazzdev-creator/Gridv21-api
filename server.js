import express from 'express';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const THRESHOLDS = { render: 300, supabase: 500 };
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const RENDER_SERVICE_ID = process.env.RENDER_SERVICE_ID;

const MICRO_CAPEX = {
  budget: 87,
  spent: 0,
  target_days: 14,
  daily_target_revenue: 300/14
};

class Brain {
  static async getLast24hRevenue() {
    const since = new Date(Date.now() - 24*60*60*1000).toISOString();
    const { data } = await supabase.from('revenue_log').select('amount').gte('created_at', since);
    return data?.reduce((sum, r) => sum + parseFloat(r.amount), 0) || 0;
  }

  static async getMonthlyProjection() {
    const daily = await this.getLast24hRevenue();
    return daily * 30;
  }

  static async getRevenueBySource(days = 30) {
    const since = new Date(Date.now() - days*24*60*60*1000).toISOString();
    const { data } = await supabase.from('revenue_log').select('amount, source, created_at').gte('created_at', since);
    const bySource = {};
    data?.forEach(r => {
      bySource[r.source] = (bySource[r.source] || 0) + parseFloat(r.amount);
    });
    return bySource;
  }

  static async logRevenue(amount, source = 'manual') {
    if (amount > 0) {
      await supabase.from('revenue_log').insert({ amount, source, created_at: new Date() });
    }
  }

  static async autoUpgrade() {
    const monthly = await this.getMonthlyProjection();
    const actions = [];
    let status = 'zero_capex';

    const { data: renderTier } = await supabase.from('settings').select('value').eq('key', 'render_tier').single();
    if (monthly >= THRESHOLDS.render && renderTier?.value === 'free' && RENDER_API_KEY && RENDER_SERVICE_ID) {
      const result = await this.upgradeRender();
      if (result.success) {
        await supabase.from('settings').update({ value: 'starter', updated_at: new Date() }).eq('key', 'render_tier');
        actions.push('render_upgraded_to_starter_$7');
        status = 'upgraded';
      }
    }

    const { data: supaTier } = await supabase.from('settings').select('value').eq('key', 'supabase_tier').single();
    if (monthly >= THRESHOLDS.supabase && supaTier?.value === 'free') {
      await supabase.from('settings').update({ value: 'pro', updated_at: new Date() }).eq('key', 'supabase_tier');
      actions.push('supabase_upgrade_to_pro_$25_needed');
      status = 'upgraded';
    }

    return { monthly_projection: monthly, actions, status };
  }

  static async upgradeRender() {
    if (!RENDER_API_KEY ||!RENDER_SERVICE_ID) {
      return { error: 'Add RENDER_API_KEY + RENDER_SERVICE_ID to enable auto-upgrade' };
    }
    try {
      const res = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${RENDER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceDetails: { plan: 'starter' } })
      });
      return res.ok ? { success: true } : { error: await res.text() };
    } catch (err) {
      return { error: err.message };
    }
  }
}

// Zero cost traffic webhooks
app.post('/webhook/tiktok', async (req, res) => {
  const { clicks, revenue } = req.body;
  await Brain.logRevenue(revenue, 'tiktok_organic');
  res.json({ logged: true, source: 'tiktok_organic', cost: '$0' });
});

app.post('/webhook/pinterest', async (req, res) => {
  const { clicks, revenue } = req.body;
  await Brain.logRevenue(revenue, 'pinterest_organic');
  res.json({ logged: true, source: 'pinterest_organic', cost: '$0' });
});

app.post('/webhook/seo', async (req, res) => {
  const { clicks, revenue } = req.body;
  await Brain.logRevenue(revenue, 'seo_organic');
  res.json({ logged: true, source: 'seo_organic', cost: '$0' });
});

app.post('/webhook/youtube', async (req, res) => {
  const { clicks, revenue } = req.body;
  await Brain.logRevenue(revenue, 'youtube_organic');
  res.json({ logged: true, source: 'youtube_organic', cost: '$0' });
});

app.post('/api/revenue', async (req, res) => {
  const { amount, source } = req.body;
  await Brain.logRevenue(amount, source);
  res.json({ success: true });
});

app.get('/api/forecast', async (req, res) => {
  const daily = await Brain.getLast24hRevenue();
  const monthly = await Brain.getMonthlyProjection();
  const upgrade = await Brain.autoUpgrade();

  const api_budget = monthly > 300? monthly * 0.05 : 0;
  const costs = monthly >= 500? 32 : monthly >= 300? 7 : 0;

  res.json({
    mode: upgrade.status,
    daily_revenue: `$${daily.toFixed(2)}`,
    monthly_projection: `$${monthly.toFixed(2)}`,
    api_budget_reserve: `$${api_budget.toFixed(2)}`,
    monthly_costs: `$${costs}`,
    net_profit: `$${(monthly - costs - api_budget).toFixed(2)}`,
    days_to_render: daily > 0 && monthly < 300? Math.ceil((300 - monthly) / daily) : monthly >= 300? 'UPGRADED' : '∞',
    days_to_supabase: daily > 0 && monthly < 500? Math.ceil((500 - monthly) / daily) : monthly >= 500? 'UPGRADED' : '∞',
    cap_ex_required: monthly < 300? '$0 - Zero CapEx Mode' : monthly < 500? '$7/mo Render' : '$32/mo Total',
    auto_upgrade_ready: !!(RENDER_API_KEY && RENDER_SERVICE_ID)
  });
});

app.get('/api/traffic-forecast', async (req, res) => {
  const bySource = await Brain.getRevenueBySource(7);
  const total7d = Object.values(bySource).reduce((a,b) => a+b, 0);
  const dailyAvg = total7d / 7;
  const monthlyProj = dailyAvg * 30;
  const daysTo5k = monthlyProj > 0? Math.ceil(5000 / monthlyProj * 30) : '∞';
  const daysTo20k = monthlyProj > 0? Math.ceil(20000 / monthlyProj * 30) : '∞';

  const sourceBreakdown = Object.entries(bySource).map(([src, amt]) => ({
    source: src,
    revenue_7d: `$${amt.toFixed(2)}`,
    pct: total7d > 0? `${(amt/total7d*100).toFixed(1)}%` : '0%'
  }));

  res.json({
    monthly_projection: `$${monthlyProj.toFixed(2)}`,
    days_to_5k: daysTo5k,
    days_to_20k: daysTo20k,
    sources: sourceBreakdown,
    top_source: sourceBreakdown[0]?.source || 'none'
  });
});

app.get('/api/fast-forward', async (req, res) => {
  const monthly = await Brain.getMonthlyProjection();
  const dailyAvg = await Brain.getLast24hRevenue();
  const daysIn = dailyAvg > 0 ? Math.min(14, Math.floor((monthly / 30) * 14 / dailyAvg)) : 0;
  const daysLeft = Math.max(0, 14 - daysIn);
  const revenueNeeded = Math.max(0, 300 - monthly);
  const dailyNeeded = daysLeft > 0 ? revenueNeeded / daysLeft : 0;
  
  res.json({
    micro_capex_budget: `$${MICRO_CAPEX.budget}`,
    spent_so_far: `$${MICRO_CAPEX.spent}`,
    days_remaining: daysLeft,
    daily_revenue_needed: `$${dailyNeeded.toFixed(2)}`,
    current_daily: `$${dailyAvg.toFixed(2)}`,
    status: monthly >= 300? 'THRESHOLD HIT - UPGRADED' : daysLeft === 0? 'TARGET MISSED' : 'FAST FORWARD MODE'
  });
});

app.get('/api/break-even', async (req, res) => {
  const monthly = await Brain.getMonthlyProjection();
  const fixedCosts = monthly >= 500? 32 : monthly >= 300? 7 : 0;
  const targetRevenue = 20000;
  const epc = 0.20;
  const cpc = 0.022;

  const clicksNeeded = targetRevenue / epc;
  const adSpendNeeded = monthly >= 300? clicksNeeded * cpc : 0;

  res.json({
    current_mode: monthly < 300? 'ZERO CAPEX - Organic Only' : 'PAID SCALE MODE',
    current_revenue: `$${monthly.toFixed(2)}`,
    fixed_costs: `$${fixedCosts}`,
    ad_spend_needed_for_20k: monthly < 300? '$0 until $300/mo' : `$${adSpendNeeded.toFixed(0)}`,
    total_costs_at_20k: `$${(fixedCosts + adSpendNeeded).toFixed(0)}`,
    net_profit_at_20k: `$${(targetRevenue - fixedCosts - adSpendNeeded).toFixed(0)}`,
    roas_needed: monthly < 300? 'N/A - Organic' : `${(targetRevenue/(fixedCosts + adSpendNeeded)).toFixed(2)}x`
  });
});

app.get('/', (req, res) => res.sendFile('public/index.html', { root: '.' }));

// FIXED FOR RENDER: Use process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('GridV21 Brain v3.0.1 Zero CapEx running on port', PORT));
