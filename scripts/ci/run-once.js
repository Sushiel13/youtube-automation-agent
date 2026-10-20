#!/usr/bin/env node
/**
 * One-shot runner for GitHub Actions.
 *
 * The agent is normally a long-running server with in-process cron jobs.
 * A CI runner lives for minutes, so this script boots the agent, stops its
 * internal scheduler, runs exactly ONE action, writes a job summary and exits.
 *
 * Usage: node scripts/ci/run-once.js <generate|approve|publish|status>
 *
 * Inputs (env):
 *   TOPIC, STYLE, LENGTH          generate: optional topic / style / short|medium|long
 *   GENERATION_SOURCE             generate: 'scheduler' (cron) or 'manual' (default)
 *   PRODUCTION_ID                 approve:  id of the production to approve
 *   PRIVACY_STATUS                approve:  private | unlisted | public
 *   PUBLISH_TIME                  approve:  ISO time; empty = publish on this run
 */
const fs = require('fs');
const { YouTubeAutomationAgent } = require('../../index');

const action = String(process.argv[2] || process.env.AGENT_ACTION || 'status').toLowerCase();
const env = name => (process.env[name] || '').trim() || null;

function summary(markdown) {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value ?? '').replace(/\n/g, ' ')}\n`);
  }
}

async function boot() {
  const agent = new YouTubeAutomationAgent();
  const ok = await agent.initialize();
  if (!ok) throw new Error('Agent failed to initialize — see log above.');
  // Cron jobs and the health loop only make sense in a long-lived process.
  if (agent.scheduler) await agent.scheduler.stopAutomation();
  if (agent.setupRequired) {
    throw new Error(
      'Setup incomplete: at least one AI provider key plus the YT_CREDENTIALS_JSON and ' +
      'YT_TOKENS_JSON repository secrets are required. See docs/GITHUB_ACTIONS.md.'
    );
  }
  return agent;
}

async function generate(agent) {
  const source = env('GENERATION_SOURCE') === 'scheduler' ? 'scheduler' : 'manual';
  const input = {
    topic: env('TOPIC'),
    style: env('STYLE'),
    length: env('LENGTH') || 'medium',
    source
  };
  summary(`## 🎬 Generate\nTopic: \`${input.topic || 'auto'}\` · Style: \`${input.style || 'auto'}\` · Length: \`${input.length}\` · Source: \`${source}\``);

  const job = await agent.startGenerationJob(input);
  const finished = await agent.waitForGenerationJob(job.id);
  setOutput('production_id', finished.production_id || finished.productionId || '');

  if (finished.status !== 'completed') {
    summary(`❌ Job \`${job.id}\` ended as **${finished.status}** at stage \`${finished.stage}\`: ${finished.error || 'unknown error'}`);
    process.exitCode = 1;
    return;
  }
  const productionId = finished.production_id || finished.productionId;
  summary(
    `✅ **${finished.title || 'Untitled'}** — production \`${productionId}\`, stage \`${finished.stage}\`.\n\n` +
    'Download the **generated-media** artifact from this run, watch the MP4, then run this workflow ' +
    `with action **approve** and production id \`${productionId}\` to schedule it for upload.`
  );
}

async function approve(agent) {
  const productionId = env('PRODUCTION_ID');
  if (!productionId) throw new Error('approve needs a production_id input');
  const input = { factChecked: true, rightsConfirmed: true };
  if (env('PRIVACY_STATUS')) input.privacyStatus = env('PRIVACY_STATUS');
  input.publishTime = env('PUBLISH_TIME') || new Date().toISOString();

  const result = await agent.approveContent(productionId, input);
  summary(`## ✅ Approved \`${productionId}\`\nQuality score: ${result.qualityScore} · Scheduled for: ${result.schedule?.publishTime}`);
  await publish(agent); // uploads now if the publish time has already passed
}

async function publish(agent) {
  await agent.agents.publishing.loadPublishQueue();
  const count = await agent.agents.publishing.processPublishQueue();
  summary(`## 📤 Publish queue\nUploaded **${count || 0}** video(s) to YouTube on this run.`);
}

async function status(agent) {
  const rows = await agent.db.getAllRows(
    `SELECT p.id, p.status, p.created_at, cr.status AS review_status,
            json_extract(ps.script, '$.title') AS title, s.publish_time, s.status AS schedule_status
       FROM productions p
       LEFT JOIN production_snapshots ps ON ps.production_id = p.id
       LEFT JOIN content_reviews cr ON cr.production_id = p.id
       LEFT JOIN publish_schedule s ON s.production_id = p.id
      ORDER BY p.created_at DESC LIMIT 15`
  ).catch(() => []);
  if (!rows.length) {
    summary('## 📋 Productions\n_No productions yet._');
    return;
  }
  const lines = rows.map(r =>
    `| \`${r.id}\` | ${(r.title || '—').replace(/\|/g, '/')} | ${r.review_status || r.status} | ${r.schedule_status || '—'} | ${r.publish_time || '—'} |`
  );
  summary(['## 📋 Recent productions', '| ID | Title | Review | Schedule | Publish time |', '|---|---|---|---|---|', ...lines].join('\n'));
}

const actions = { generate, approve, publish, status };

(async () => {
  if (!actions[action]) throw new Error(`Unknown action "${action}". Use: ${Object.keys(actions).join(', ')}`);
  const agent = await boot();
  try {
    await actions[action](agent);
    if (action !== 'status') await status(agent);
  } finally {
    await agent.db?.close?.().catch(() => {});
  }
})()
  .then(() => process.exit(process.exitCode || 0))
  .catch(error => {
    summary(`## ❌ ${action} failed\n\`\`\`\n${error.message}\n\`\`\``);
    console.error(error);
    process.exit(1);
  });
