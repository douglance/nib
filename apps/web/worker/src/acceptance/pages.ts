const REVIEW_PATH =
  /^\/acceptance\/projects\/([^/]+)\/reviews\/([^/]+)\/?$/;

export function acceptancePage(request: Request): Response | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;

  const url = new URL(request.url);
  const review = url.pathname.match(REVIEW_PATH);
  if (url.pathname !== "/acceptance" && !review) return null;

  const bootstrap = {
    apiPrefix: "/api/acceptance/v1",
    route: review
      ? { name: "review", projectId: review[1]!, reviewId: review[2]! }
      : { name: "admin" },
  };

  return html(acceptanceShell(bootstrap));
}

function acceptanceShell(bootstrap: object): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nib Acceptance</title>
${styles()}
<body>
<div class="app-shell">
  <header class="topbar" aria-label="Acceptance workspace">
    <a class="brand" href="/acceptance" aria-label="Nib Acceptance home">
      <span class="brand-mark" aria-hidden="true">N</span>
      <span><strong>Nib</strong><small>Acceptance</small></span>
    </a>
    <nav class="nav-pills" aria-label="Acceptance views">
      <a href="/acceptance" data-nav="admin">Admin</a>
      <a href="/acceptance" data-nav="review">Review</a>
    </nav>
    <p id="account-chip" class="badge" hidden></p>
  </header>
  <main id="app" class="surface" tabindex="-1" aria-live="polite">
    <section class="loading-state" aria-label="Loading acceptance workspace">
      <p class="eyebrow">Acceptance</p>
      <h1>Loading review controls</h1>
      <div class="skeleton wide"></div>
      <div class="skeleton"></div>
      <div class="skeleton short"></div>
    </section>
  </main>
</div>
<script type="application/json" id="acceptance-bootstrap">${scriptJson(bootstrap)}</script>
<script>${script()}</script>
</body>
</html>`;
}

function styles(): string {
  return `<style>
:root {
  color-scheme: light;
  --bg: #f6f4ee;
  --panel: #fffdfa;
  --panel-strong: #ffffff;
  --ink: #171717;
  --muted: #5c5c55;
  --line: #d8d3c7;
  --line-strong: #bbb3a3;
  --accent: #0f5c68;
  --accent-dark: #0a3f49;
  --accent-soft: #dceff1;
  --ok: #147447;
  --ok-soft: #def4e9;
  --warn: #9b5b00;
  --warn-soft: #fff0d1;
  --bad: #a7342d;
  --bad-soft: #fae2df;
  --info: #3158a4;
  --info-soft: #e2e9fb;
  --shadow: 0 18px 48px rgba(24, 21, 16, .10);
  font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { min-width: 320px; background: var(--bg); color: var(--ink); }
body { margin: 0; min-height: 100vh; }
button, input, select, textarea { font: inherit; }
button, a, input, select, textarea { outline-color: var(--accent); outline-offset: 3px; }
a { color: inherit; }

.app-shell {
  min-height: 100vh;
  display: grid;
  grid-template-rows: auto 1fr;
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: .85rem clamp(1rem, 4vw, 2.5rem);
  background: rgba(246, 244, 238, .92);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(14px);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: .7rem;
  text-decoration: none;
}

.brand-mark {
  width: 2rem;
  height: 2rem;
  display: grid;
  place-items: center;
  border: 1px solid var(--ink);
  border-radius: .45rem;
  background: var(--ink);
  color: white;
  font-weight: 800;
}

.brand strong, .brand small { display: block; line-height: 1.1; }
.brand small { color: var(--muted); font-size: .78rem; font-weight: 650; }

.nav-pills {
  display: flex;
  align-items: center;
  gap: .35rem;
  padding: .25rem;
  border: 1px solid var(--line);
  border-radius: .6rem;
  background: rgba(255, 255, 255, .72);
}

.nav-pills a {
  min-height: 2.25rem;
  display: inline-flex;
  align-items: center;
  padding: .35rem .75rem;
  border-radius: .45rem;
  color: var(--muted);
  font-size: .92rem;
  font-weight: 700;
  text-decoration: none;
}

.nav-pills a[aria-current="page"] {
  background: var(--ink);
  color: white;
}

.surface {
  width: min(100%, 1440px);
  margin: 0 auto;
  padding: clamp(1rem, 3vw, 2.5rem);
}

.stack { display: grid; gap: 1rem; }
.workspace-grid { display: grid; grid-template-columns: minmax(17rem, 22rem) minmax(0, 1fr); gap: 1rem; align-items: start; }
.review-grid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(19rem, .75fr); gap: 1rem; align-items: start; }
.panel-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
.actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }

.panel, .hero-panel, .list-item, .state-box {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: .55rem;
  box-shadow: var(--shadow);
}

.panel, .hero-panel, .state-box { padding: clamp(1rem, 2vw, 1.4rem); }
.hero-panel { display: grid; gap: 1rem; background: linear-gradient(135deg, #fffdfa 0%, #eef7f6 100%); }
.panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
.panel-title { margin: 0; font-size: 1.05rem; line-height: 1.25; }
.panel-note, .muted { color: var(--muted); }
.panel-note { margin: .2rem 0 0; font-size: .92rem; }
.eyebrow { margin: 0 0 .35rem; color: var(--accent-dark); font-size: .72rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 0; max-width: 48rem; font-size: clamp(1.8rem, 4vw, 3.35rem); line-height: .98; letter-spacing: 0; }
h2, h3 { letter-spacing: 0; }
p { margin: 0; }
.lede { max-width: 62rem; color: #3f403b; font-size: clamp(1rem, 1.6vw, 1.18rem); }

.status-row {
  display: flex;
  align-items: center;
  gap: .5rem;
  flex-wrap: wrap;
}

.badge {
  min-height: 1.8rem;
  display: inline-flex;
  align-items: center;
  gap: .35rem;
  padding: .25rem .55rem;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: white;
  color: var(--muted);
  font-size: .78rem;
  font-weight: 800;
}

.badge.ok { border-color: #9fd5ba; background: var(--ok-soft); color: var(--ok); }
.badge.warn { border-color: #efcd87; background: var(--warn-soft); color: var(--warn); }
.badge.bad { border-color: #e0a39d; background: var(--bad-soft); color: var(--bad); }
.badge.info { border-color: #b6c5ec; background: var(--info-soft); color: var(--info); }

.metric-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: .6rem;
}

.metric {
  min-height: 5rem;
  padding: .8rem;
  border: 1px solid var(--line);
  border-radius: .5rem;
  background: rgba(255, 255, 255, .72);
}

.metric span { display: block; color: var(--muted); font-size: .78rem; font-weight: 750; }
.metric strong { display: block; margin-top: .25rem; font-size: 1.15rem; line-height: 1.15; word-break: break-word; }

.list { display: grid; gap: .55rem; }
.list-item { padding: .85rem; box-shadow: none; }
.list-item[aria-selected="true"] { border-color: var(--accent); background: var(--accent-soft); }
.list-item button.link-button { text-align: left; width: 100%; }

.criteria-list { display: grid; gap: .65rem; }
.criterion {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: .7rem;
  padding: .8rem;
  border: 1px solid var(--line);
  border-radius: .5rem;
  background: var(--panel-strong);
}

.criterion input { width: 1.1rem; height: 1.1rem; margin-top: .2rem; accent-color: var(--accent); }
.criterion strong { display: block; }
.criterion small { display: block; margin-top: .25rem; color: var(--muted); }

.evidence-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .65rem; }
.evidence-item {
  min-height: 5.25rem;
  display: grid;
  gap: .35rem;
  padding: .8rem;
  border: 1px solid var(--line);
  border-radius: .5rem;
  background: var(--panel-strong);
}

.evidence-item a { color: var(--accent-dark); font-weight: 750; overflow-wrap: anywhere; }
.evidence-meta { color: var(--muted); font-size: .82rem; overflow-wrap: anywhere; }

.timeline { display: grid; gap: .7rem; }
.timeline-item {
  display: grid;
  grid-template-columns: .65rem minmax(0, 1fr);
  gap: .65rem;
}
.timeline-dot { width: .65rem; height: .65rem; margin-top: .45rem; border-radius: 999px; background: var(--accent); }
.timeline-card { padding-bottom: .7rem; border-bottom: 1px solid var(--line); }
.timeline-card strong { display: block; }
.timeline-card small { display: block; color: var(--muted); }

form { display: grid; gap: .75rem; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
label { display: grid; gap: .35rem; color: var(--muted); font-size: .82rem; font-weight: 750; }
input, select, textarea {
  width: 100%;
  min-height: 2.75rem;
  border: 1px solid var(--line-strong);
  border-radius: .45rem;
  background: white;
  color: var(--ink);
  padding: .58rem .7rem;
}
textarea { min-height: 6rem; resize: vertical; }
input[type="checkbox"] { width: 1.1rem; min-height: 1.1rem; accent-color: var(--accent); }
.checkline { display: flex; align-items: center; gap: .5rem; color: var(--ink); }

button, .button {
  min-height: 2.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: .4rem;
  border: 1px solid var(--ink);
  border-radius: .45rem;
  background: var(--ink);
  color: white;
  padding: .55rem .85rem;
  font-weight: 800;
  text-decoration: none;
  cursor: pointer;
}

button.secondary, .button.secondary { border-color: var(--line-strong); background: white; color: var(--ink); }
button.ghost { border-color: transparent; background: transparent; color: var(--accent-dark); padding-inline: .25rem; }
button.danger { border-color: var(--bad); background: var(--bad); }
button:disabled, .button[aria-disabled="true"] { cursor: not-allowed; opacity: .52; }
.link-button { border: 0; background: transparent; color: inherit; padding: 0; min-height: 0; justify-content: flex-start; }

.notice {
  display: grid;
  gap: .25rem;
  padding: .75rem .85rem;
  border: 1px solid var(--line);
  border-radius: .5rem;
  background: white;
}
.notice.warn { border-color: #efcd87; background: var(--warn-soft); color: #593500; }
.notice.bad { border-color: #e0a39d; background: var(--bad-soft); color: #711d18; }
.notice.info { border-color: #b6c5ec; background: var(--info-soft); color: #223f79; }
.notice strong { display: block; }

.empty-state, .loading-state, .error-state {
  min-height: min(72vh, 42rem);
  display: grid;
  align-content: center;
  justify-items: start;
  gap: .8rem;
  padding: clamp(1.2rem, 4vw, 2.5rem);
}

.skeleton {
  height: 1rem;
  width: min(28rem, 72vw);
  border-radius: 999px;
  background: linear-gradient(90deg, #e5dfd2, #f8f5ec, #e5dfd2);
  background-size: 220% 100%;
  animation: shimmer 1.4s linear infinite;
}
.skeleton.wide { width: min(42rem, 80vw); height: 1.45rem; }
.skeleton.short { width: min(18rem, 62vw); }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@keyframes shimmer { to { background-position-x: -220%; } }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; }
}

@media (max-width: 980px) {
  .workspace-grid, .review-grid, .panel-grid { grid-template-columns: 1fr; }
  .metric-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 640px) {
  .topbar { align-items: stretch; flex-direction: column; }
  .nav-pills { width: 100%; }
  .nav-pills a { flex: 1; justify-content: center; }
  .surface { padding: .85rem; }
  .metric-strip, .field-grid, .evidence-grid { grid-template-columns: 1fr; }
  .panel-header { display: grid; }
  .actions, .toolbar { align-items: stretch; flex-direction: column; }
  button, .button { width: 100%; }
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #141414;
    --panel: #1d1d1b;
    --panel-strong: #242421;
    --ink: #f4f1e8;
    --muted: #b9b3a8;
    --line: #38352f;
    --line-strong: #5a5449;
    --accent: #77c9d3;
    --accent-dark: #a7e3e9;
    --accent-soft: #173338;
    --shadow: none;
  }
  .topbar { background: rgba(20, 20, 20, .92); }
  .brand-mark, button, .button { background: var(--ink); color: #141414; }
  button.secondary, .button.secondary, input, select, textarea, .badge, .notice { background: #242421; color: var(--ink); }
  .nav-pills { background: #242421; border-color: var(--line-strong); }
  .nav-pills a { color: #d9d4ca; }
  .nav-pills a[aria-current="page"] { background: var(--accent); color: #141414; }
  .hero-panel { background: linear-gradient(135deg, #1d1d1b 0%, #173338 100%); }
  .lede { color: #d9d4ca; }
  .metric { background: #242421; }
}
</style>`;
}

function script(): string {
  return `
const root = document.querySelector("#app");
const boot = JSON.parse(document.querySelector("#acceptance-bootstrap").textContent);
const api = boot.apiPrefix;
const terminalStates = new Set(["approved", "rejected", "revision_requested", "expired", "superseded", "invalidated"]);
let state = { teams: [], selectedTeamId: "", selectedProjectId: "", review: null, reviews: [], viewedReviewKeys: {}, viewedReviewAttempts: new Set() };

document.querySelectorAll("[data-nav]").forEach(link => {
  const target = link.getAttribute("data-nav");
  if ((boot.route.name === "admin" && target === "admin") || (boot.route.name === "review" && target === "review")) {
    link.setAttribute("aria-current", "page");
  }
});

start().catch(error => renderFatal(error));

async function start() {
  await loadSession();
  if (boot.route.name === "review") {
    await renderReviewPage(boot.route.projectId, boot.route.reviewId);
    return;
  }
  await renderAdminPage();
}

async function loadSession() {
  try {
    const session = await getJson("/api/auth/session");
    showAccountChip(session.account);
  } catch {}
}

function showAccountChip(account) {
  const chip = document.querySelector("#account-chip");
  const email = account?.email || account?.id;
  if (chip && email) {
    chip.hidden = false;
    chip.textContent = email;
  }
}

async function renderAdminPage() {
  root.innerHTML = adminShell();
  renderInvitationPrompt();
  bindAdminForms();
  await loadAdmin();
}

function renderInvitationPrompt() {
  const token = new URL(location.href).searchParams.get("invitation");
  if (!token) return;
  const panel = document.createElement("section");
  panel.className = "panel";
  panel.innerHTML = '<div class="panel-header"><div><p class="eyebrow">Invitation</p><h2 class="panel-title">Accept team invitation</h2><p class="panel-note">The invitation is bound to your signed-in email and will report the API result.</p></div></div>' +
    '<form data-mutation="invitation-accept" data-token="' + escAttr(token) + '"><button>Accept invitation</button><p role="status" class="muted"></p></form>';
  root.querySelector(".stack")?.prepend(panel);
  panel.querySelector("form")?.addEventListener("submit", submitAdminMutation);
}

async function loadAdmin() {
  setStatus("admin-status", "Loading teams and projects...");
  try {
    const payload = await getJson(api + "/teams");
    state.teams = Array.isArray(payload.teams) ? payload.teams : [];
    if (!state.teams.some(team => team.id === state.selectedTeamId)) state.selectedTeamId = state.teams[0]?.id || "";
    renderTeamRail();
    await loadTeamDetail();
    setStatus("admin-status", "");
  } catch (error) {
    renderError("admin-main", "Acceptance administration did not load.", error);
  }
}

async function loadTeamDetail() {
  if (!state.selectedTeamId) {
    document.querySelector("#admin-main").innerHTML = emptyState("No acceptance teams", "Create a team to start publishing review packets and assigning reviewers.");
    return;
  }
  const [teamResult, membersResult, invitationsResult, projectsResult] = await Promise.allSettled([
    getJson(api + "/teams/" + encodeURIComponent(state.selectedTeamId)),
    getJson(api + "/teams/" + encodeURIComponent(state.selectedTeamId) + "/members"),
    getJson(api + "/teams/" + encodeURIComponent(state.selectedTeamId) + "/invitations"),
    getJson(api + "/teams/" + encodeURIComponent(state.selectedTeamId) + "/projects"),
  ]);
  if (teamResult.status === "rejected") throw teamResult.reason;
  const team = teamResult.value.team || teamResult.value;
  team.members = membersResult.status === "fulfilled" ? membersResult.value.members || [] : [];
  team.invitations = invitationsResult.status === "fulfilled" ? invitationsResult.value.invitations || [] : [];
  team.projects = projectsResult.status === "fulfilled" ? projectsResult.value.projects || [] : [];
  team.loadErrors = [membersResult, invitationsResult, projectsResult]
    .filter(result => result.status === "rejected")
    .map(result => errorMessage(result.reason));
  if (!team.projects?.some(project => project.id === state.selectedProjectId)) state.selectedProjectId = team.projects?.[0]?.id || "";
  if (state.selectedProjectId) {
    const project = team.projects.find(item => item.id === state.selectedProjectId);
    if (project) Object.assign(project, await hydrateProject(project));
  }
  renderTeamDetail(team);
}

async function hydrateProject(project) {
  const projectId = project.id;
  const [detailResult, membersResult, credentialsResult, githubResult, webhooksResult, metricsResult] = await Promise.allSettled([
    getJson(api + "/projects/" + enc(projectId)),
    getJson(api + "/projects/" + enc(projectId) + "/members"),
    getJson(api + "/projects/" + enc(projectId) + "/credentials"),
    getJson(api + "/projects/" + enc(projectId) + "/integrations/github"),
    getJson(api + "/projects/" + enc(projectId) + "/integrations/webhooks"),
    getJson(api + "/projects/" + enc(projectId) + "/metrics"),
  ]);
  const detail = detailResult.status === "fulfilled" ? detailResult.value.project || detailResult.value : project;
  return {
    ...project,
    ...detail,
    members: membersResult.status === "fulfilled" ? membersResult.value.members || [] : [],
    credentials: credentialsResult.status === "fulfilled" ? credentialsResult.value.credentials || [] : [],
    githubInstallations: githubResult.status === "fulfilled" ? githubResult.value.installations || [] : [],
    webhooks: webhooksResult.status === "fulfilled" ? webhooksResult.value.webhooks || [] : [],
    deliveries: webhooksResult.status === "fulfilled" ? webhooksResult.value.deliveries || [] : [],
    metrics: metricsResult.status === "fulfilled" ? metricsResult.value : null,
    loadErrors: [detailResult, membersResult, credentialsResult, githubResult, webhooksResult, metricsResult]
      .filter(result => result.status === "rejected")
      .map(result => errorMessage(result.reason)),
  };
}

async function renderReviewPage(projectId, reviewId) {
  root.innerHTML = reviewLoading();
  try {
    const review = await getJson(api + "/projects/" + encodeURIComponent(projectId) + "/reviews/" + encodeURIComponent(reviewId));
    state.review = review;
    showAccountChip(review.currentUser);
    root.innerHTML = reviewShell(review);
    bindReviewControls(review);
    recordReviewViewedOnce(review);
  } catch (error) {
    root.innerHTML = errorState("Review did not load.", error);
  }
}

function adminShell() {
  return '<div class="stack">' +
    '<section class="hero-panel">' +
      '<div class="toolbar"><div><p class="eyebrow">Acceptance administration</p><h1>Team and project controls</h1></div><span class="badge info">Private by default</span></div>' +
      '<p class="lede">Manage team access, review policy, and connected workflows.</p>' +
      '<div class="status-row"><span id="admin-status" role="status" class="muted"></span></div>' +
    '</section>' +
    '<div class="workspace-grid">' +
      '<aside class="panel"><div class="panel-header"><div><h2 class="panel-title">Teams</h2><p class="panel-note">Switch workspace or create one.</p></div></div><div id="team-list" class="list"></div>' + teamCreateForm() + '</aside>' +
      '<section id="admin-main" class="stack">' + loadingBlock() + '</section>' +
    '</div>' +
  '</div>';
}

function teamCreateForm() {
  return '<form id="team-create-form" data-mutation="create-team">' +
    '<label>Team name<input name="name" autocomplete="organization" required></label>' +
    '<button>Create team</button>' +
    '<p id="create-team-status" role="status" class="muted"></p>' +
  '</form>';
}

function renderTeamRail() {
  const list = document.querySelector("#team-list");
  if (!state.teams.length) {
    list.innerHTML = '<div class="state-box"><strong>No teams yet</strong><p class="muted">Create a team to configure acceptance gates.</p></div>';
    return;
  }
  list.innerHTML = state.teams.map(team => '<div class="list-item" aria-selected="' + String(team.id === state.selectedTeamId) + '">' +
    '<button class="link-button" data-team-id="' + escAttr(team.id) + '"><strong>' + esc(team.name || team.id) + '</strong><small class="muted">' + esc(team.role || "member") + '</small></button>' +
  '</div>').join("");
  list.querySelectorAll("[data-team-id]").forEach(button => {
    button.addEventListener("click", async () => {
      state.selectedTeamId = button.getAttribute("data-team-id");
      state.selectedProjectId = "";
      renderTeamRail();
      await loadTeamDetail().catch(error => renderError("admin-main", "Team details did not load.", error));
    });
  });
}

function renderTeamDetail(team) {
  const projects = Array.isArray(team.projects) ? team.projects : [];
  if (!state.selectedProjectId) state.selectedProjectId = projects[0]?.id || "";
  const selectedProject = projects.find(project => project.id === state.selectedProjectId) || projects[0];
  const main = document.querySelector("#admin-main");
  main.innerHTML = '<section class="panel">' +
      '<div class="panel-header"><div><p class="eyebrow">Team</p><h2 class="panel-title">' + esc(team.name || team.id) + '</h2><p class="panel-note">' + esc(team.id) + '</p></div><span class="badge">' + esc(team.role || "member") + '</span></div>' +
      loadErrorNotices(team.loadErrors) +
      '<div class="panel-grid">' + teamMembersPanel(team) + invitationsPanel(team) + '</div>' +
      '<form data-mutation="team-archive" data-team-id="' + escAttr(team.id) + '"><button class="danger">Archive team</button><p role="status" class="muted"></p></form>' +
    '</section>' +
    '<section class="panel">' +
      '<div class="panel-header"><div><h2 class="panel-title">Projects</h2><p class="panel-note">Set review policy, visibility, and access.</p></div></div>' +
      '<div class="workspace-grid"><div class="list">' + projectList(projects) + projectCreateForm(team.id) + '</div><div id="project-detail">' + (selectedProject ? projectDetail(selectedProject, team.id) : emptyState("No projects", "Create a project before publishing acceptance reviews.")) + '</div></div>' +
    '</section>' +
    '<section class="panel">' +
      '<div class="panel-header"><div><h2 class="panel-title">Delivery configuration</h2><p class="panel-note">GitHub and webhooks use project-scoped credentials and report delivery failures from the API.</p></div></div>' +
      '<div id="delivery-detail">' + (selectedProject ? deliveryDetail(selectedProject, team.id) : emptyState("No project selected", "Select a project to configure delivery.")) + '</div>' +
    '</section>' +
    '<section class="panel">' +
      '<div class="panel-header"><div><h2 class="panel-title">Review activity</h2><p class="panel-note">Open a review to see its criteria, discussion, and decisions.</p></div></div>' +
      '<div id="project-reviews">' + (selectedProject ? loadingBlock() : emptyState("No project selected", "Select a project to see reviews.")) + '</div>' +
    '</section>';
  bindTeamDetail(team);
  if (selectedProject) void loadProjectReviews(selectedProject.id);
}

function teamMembersPanel(team) {
  const members = Array.isArray(team.members) ? team.members : [];
  const rows = members.length ? members.map(member => '<div class="list-item">' +
    '<div class="toolbar"><div><strong>' + esc(member.email || member.accountId) + '</strong><p class="muted">' + esc(member.accountId) + '</p></div>' +
    '<form data-mutation="team-member" data-account-id="' + escAttr(member.accountId) + '">' +
      '<div class="actions"><select name="role" aria-label="Team role for ' + escAttr(member.email || member.accountId) + '">' + roleOptions(member.role, ["owner", "admin", "member"]) + '</select><button class="secondary">Save</button><button class="danger" name="remove" value="1">Remove</button></div>' +
    '</form></div></div>').join("") : '<div class="state-box"><strong>No members returned</strong><p class="muted">The API did not return team members for this account.</p></div>';
  return '<section><div class="panel-header"><div><h3 class="panel-title">Members</h3><p class="panel-note">Owner transfer and role edits are explicit writes.</p></div></div>' + rows +
    '<form data-mutation="owner-transfer"><label>Transfer owner to account ID<input name="accountId" required></label><button class="secondary">Transfer owner</button></form></section>';
}

function invitationsPanel(team) {
  const invitations = Array.isArray(team.invitations) ? team.invitations : [];
  const rows = invitations.length ? invitations.map(invite => '<div class="list-item"><strong>' + esc(invite.email) + '</strong><p class="muted">' + esc(invite.role || "member") + ' · expires ' + esc(dateLabel(invite.expiresAt)) + '</p></div>').join("") : '<div class="state-box"><strong>No pending invites</strong><p class="muted">Invitations expire after 7 days.</p></div>';
  return '<section><div class="panel-header"><div><h3 class="panel-title">Invites</h3><p class="panel-note">Email-bound invitation tokens expire in 7 days.</p></div></div>' + rows +
    '<form data-mutation="invite"><div class="field-grid"><label>Email<input type="email" name="email" required></label><label>Role<select name="role">' + roleOptions("member", ["admin", "member"]) + '</select></label></div><button>Invite member</button></form></section>';
}

function projectList(projects) {
  if (!projects.length) return '<div class="state-box"><strong>No projects</strong><p class="muted">Create one to publish and verify review gates.</p></div>';
  return projects.map(project => '<div class="list-item" aria-selected="' + String(project.id === state.selectedProjectId) + '">' +
    '<button class="link-button" data-project-id="' + escAttr(project.id) + '"><strong>' + esc(project.name || project.id) + '</strong><small class="muted">' + esc(project.enabled === false ? "Disabled" : "Enabled") + ' · ' + esc(project.publicRead ? "Public read" : "Private") + '</small></button>' +
  '</div>').join("");
}

function projectCreateForm(teamId) {
  return '<form data-mutation="project-create" data-team-id="' + escAttr(teamId) + '"><label>Project name<input name="name" required></label><button>Create project</button></form>';
}

function projectDetail(project, teamId) {
  const quorum = Math.max(1, Math.min(99, Number(project.policy?.quorum || project.quorum || 1)));
  const ttlDays = Math.max(1, Math.round(Number(project.policy?.ttlSeconds || project.ttlSeconds || 604800) / 86400));
  return '<div class="stack">' +
    loadErrorNotices(project.loadErrors) +
    '<form data-mutation="project-settings" data-project-id="' + escAttr(project.id) + '">' +
      '<div class="field-grid"><label>Project name<input name="name" value="' + escAttr(project.name || "") + '" required></label><label>Review quorum<input type="number" name="quorum" min="1" step="1" value="' + escAttr(String(quorum)) + '" required></label></div>' +
      '<div class="field-grid"><label>TTL days<input type="number" name="ttlDays" min="1" max="7" step="1" value="' + escAttr(String(Math.min(7, ttlDays))) + '" required></label><label>Project state<select name="enabled"><option value="true"' + selected(project.enabled !== false) + '>Enabled</option><option value="false"' + selected(project.enabled === false) + '>Disabled</option></select></label></div>' +
      '<label class="checkline"><input type="checkbox" name="publicRead"' + (project.publicRead ? " checked" : "") + '>Public read-only review links</label>' +
      '<button>Save project policy</button>' +
    '</form>' +
    projectUsagePanel(project.metrics) +
    '<form data-mutation="project-archive" data-project-id="' + escAttr(project.id) + '"><button class="danger">Archive project</button><p role="status" class="muted"></p></form>' +
    projectMembers(project) +
  '</div>';
}

function projectUsagePanel(metrics) {
  if (!metrics) return emptyState("Usage metrics unavailable", "Project metrics load for project admins only.");
  const events = metrics.events || {};
  const distinct = metrics.distinct || {};
  const first = metrics.firstReview || {};
  const repeat = metrics.repeatUsage || {};
  const github = metrics.github || {};
  return '<section class="state-box"><div class="panel-header"><div><h3 class="panel-title">Project usage</h3><p class="panel-note">Track how your team uses acceptance reviews.</p></div></div>' +
    '<div class="metric-strip compact">' +
      metric("Published", distinct.publishedReviews ?? events.reviewPublished ?? 0) +
      metric("Viewed", distinct.humanViewedReviews ?? events.reviewPageViewed ?? 0) +
      metric("Decided", distinct.decidedReviews ?? events.reviewDecisionRecorded ?? 0) +
      metric("First decision", formatDuration(first.decisionAfterPublishSeconds)) +
    '</div>' +
    '<div class="panel-grid">' +
      subList("Repeat use", [
        String(repeat.reviewersWithMultipleReviews || 0) + " reviewers with multiple reviews",
        String(repeat.reviewsWithMultipleHumanEventTypes || 0) + " reviews with viewed/opened/decided activity",
      ]) +
      subList("Delivery setup", [
        String(github.installations || 0) + " GitHub installations",
        "First review after install: " + formatDuration(github.installToFirstReviewSeconds),
      ]) +
    '</div></section>';
}

function projectMembers(project) {
  const members = Array.isArray(project.members) ? project.members : [];
  const rows = members.length ? members.map(member => '<div class="list-item"><div class="toolbar"><div><strong>' + esc(member.email || member.accountId) + '</strong><p class="muted">' + esc(member.accountId) + '</p></div>' +
    '<form data-mutation="project-member" data-project-id="' + escAttr(project.id) + '" data-account-id="' + escAttr(member.accountId) + '"><div class="actions"><select name="role" aria-label="Project role for ' + escAttr(member.email || member.accountId) + '">' + roleOptions(member.role, ["admin", "reviewer", "viewer"]) + '</select><button class="secondary">Save</button><button class="danger" name="remove" value="1">Remove</button></div></form></div></div>').join("") : '<div class="state-box"><strong>No explicit project members</strong><p class="muted">Team admins inherit project administration.</p></div>';
  return '<section><div class="panel-header"><div><h3 class="panel-title">Project roles</h3><p class="panel-note">Admins and reviewers can comment and vote; viewers are read-only.</p></div></div>' + rows +
    '<form data-mutation="project-member-add" data-project-id="' + escAttr(project.id) + '"><div class="field-grid"><label>Account ID<input name="accountId" required></label><label>Role<select name="role">' + roleOptions("reviewer", ["admin", "reviewer", "viewer"]) + '</select></label></div><button>Add project member</button></form></section>';
}

function deliveryDetail(project) {
  const credentials = Array.isArray(project.credentials) ? project.credentials : [];
  const webhooks = Array.isArray(project.webhooks) ? project.webhooks : [];
  const githubInstallations = Array.isArray(project.githubInstallations) ? project.githubInstallations : [];
  const credentialRows = credentials.length ? credentials.map(credential => '<div class="list-item"><div class="toolbar"><div><strong>' + esc(credential.name || credential.id) + '</strong><p class="muted">' + esc((credential.scopes || []).join(", ")) + '</p></div><form data-mutation="credential-delete" data-project-id="' + escAttr(project.id) + '" data-credential-id="' + escAttr(credential.id) + '"><button class="danger">Delete</button></form></div></div>').join("") : '<div class="state-box"><strong>No credentials</strong><p class="muted">Create scoped credentials for automation publish, read, or verify.</p></div>';
  const webhookRows = webhooks.length ? webhooks.map(hook => '<div class="list-item"><div class="toolbar"><div><strong>' + esc(hook.url || hook.id) + '</strong><p class="muted">' + esc(hook.enabled === false ? "Disabled" : "Enabled") + ' · ' + esc(hook.lastDeliveryStatus || "No delivery yet") + '</p></div><form data-mutation="webhook-save" data-project-id="' + escAttr(project.id) + '" data-webhook-id="' + escAttr(hook.id) + '"><div class="actions"><select name="enabled" aria-label="Webhook state"><option value="true"' + selected(hook.enabled !== false) + '>Enabled</option><option value="false"' + selected(hook.enabled === false) + '>Disabled</option></select><button class="secondary">Save</button><button class="danger" name="remove" value="1">Delete</button></div></form></div></div>').join("") : '<div class="state-box"><strong>No webhooks</strong><p class="muted">Add a delivery URL to receive acceptance.changed events.</p></div>';
  const githubRows = githubInstallations.length ? githubInstallations.map(installation => {
    const repository = installation.repository || {};
    return '<div class="list-item"><div class="toolbar"><div><strong>' + esc(repository.owner && repository.name ? repository.owner + "/" + repository.name : installation.repositoryId || installation.id) + '</strong><p class="muted">Installation ' + esc(installation.installationId || "unknown") + ' · ' + esc(installation.enabled === false ? "Disabled" : "Enabled") + '</p></div><form data-mutation="github-delete" data-project-id="' + escAttr(project.id) + '" data-repository-id="' + escAttr(repository.id || installation.repositoryId || "") + '"><button class="danger">Disable</button></form></div></div>';
  }).join("") : '<div class="state-box"><strong>No GitHub delivery</strong><p class="muted">Connect a repository before publishing checks from acceptance events.</p></div>';
  return '<div class="panel-grid"><section><h3 class="panel-title">Credentials</h3>' + credentialRows +
    '<form data-mutation="credential-create" data-project-id="' + escAttr(project.id) + '"><label>Name<input name="name" required></label><fieldset class="actions"><legend class="sr-only">Credential scopes</legend><label class="checkline"><input type="checkbox" name="scope" value="publish">Publish</label><label class="checkline"><input type="checkbox" name="scope" value="read">Read</label><label class="checkline"><input type="checkbox" name="scope" value="verify">Verify</label></fieldset><button>Create credential</button></form></section>' +
    '<section><h3 class="panel-title">GitHub and webhooks</h3>' + webhookRows +
    '<form data-mutation="webhook-create" data-project-id="' + escAttr(project.id) + '"><label>Delivery URL<input type="url" name="url" required></label><label>Description<input name="description" placeholder="Release gate notifications"></label><label>Events<textarea name="events" placeholder="acceptance.changed"></textarea></label><button>Add webhook</button></form>' +
    '<div class="divider"></div>' + githubRows +
    '<form data-mutation="github-save" data-project-id="' + escAttr(project.id) + '"><div class="field-grid"><label>Installation ID<input name="installationId" inputmode="numeric" required></label><label>Repository ID<input name="repositoryId" inputmode="numeric" required></label></div><div class="field-grid"><label>Owner<input name="owner" required></label><label>Name<input name="name" required></label></div><label>Allowed workflow refs<textarea name="allowedWorkflows" required placeholder="douglance/nib/.github/workflows/acceptance.yml@refs/heads/main"></textarea></label><label>Gates<textarea name="gates" placeholder="acceptance"></textarea></label><label>Repository ownership proof<input type="password" name="ownershipOidcToken" required autocomplete="off" spellcheck="false" placeholder="Short-lived GitHub OIDC token"></label><p class="muted">Use Nib Acceptance Action link mode on the default branch to link without pasting a token here.</p><button class="secondary">Save GitHub delivery</button></form></section></div>' +
    '<section class="state-box"><div class="panel-header"><div><h3 class="panel-title">Evidence upload</h3><p class="panel-note">Add screenshots, recordings, or documents for reviewers. Maximum 16 MiB per file.</p></div></div><form data-mutation="evidence-upload" data-project-id="' + escAttr(project.id) + '"><label>Evidence file<input type="file" name="evidence" required></label><button class="secondary">Upload evidence</button><p role="status" class="muted"></p></form></section>';
}

function bindAdminForms() {
  document.querySelector("#team-create-form")?.addEventListener("submit", submitAdminMutation);
}

function bindTeamDetail(team) {
  document.querySelectorAll("[data-project-id].link-button").forEach(button => {
    button.addEventListener("click", async () => {
      state.selectedProjectId = button.getAttribute("data-project-id");
      renderTeamDetail(team);
      const project = team.projects?.find(item => item.id === state.selectedProjectId);
      if (project) {
        Object.assign(project, await hydrateProject(project));
        renderTeamDetail(team);
      }
    });
  });
  document.querySelectorAll("form[data-mutation]").forEach(form => {
    if (form.id === "team-create-form") return;
    form.addEventListener("submit", submitAdminMutation);
  });
}

async function submitAdminMutation(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter || form.querySelector("button");
  const status = nearestStatus(form);
  const mutation = form.dataset.mutation;
  try {
    button.disabled = true;
    status.textContent = "Saving...";
    if (mutation === "evidence-upload") {
      const file = form.elements.evidence.files[0];
      if (!file) throw new Error("Select an evidence file before uploading.");
      const descriptor = await sendRaw("POST", api + "/projects/" + enc(form.dataset.projectId) + "/evidence", file, file.type || "application/octet-stream", file.name);
      status.textContent = "Uploaded: " + (descriptor.label || descriptor.id || descriptor.url || "descriptor returned");
      return;
    }
    const body = Object.fromEntries(new FormData(form).entries());
    const endpoint = adminEndpoint(mutation, form, body, event.submitter);
    await sendJson(endpoint.method, endpoint.path, endpoint.body);
    status.textContent = "Saved.";
    await loadAdmin();
  } catch (error) {
    status.textContent = errorMessage(error);
  } finally {
    button.disabled = false;
  }
}

async function loadProjectReviews(projectId) {
  const target = document.querySelector("#project-reviews");
  if (!target) return;
  try {
    const payload = await getJson(api + "/projects/" + enc(projectId) + "/reviews");
    const reviews = Array.isArray(payload.reviews) ? payload.reviews : [];
    if (!reviews.length) {
      target.innerHTML = emptyState("No reviews published", "Review packets will appear here after publish.");
      return;
    }
    target.innerHTML = '<div class="list">' + reviews.map(review => '<a class="list-item" href="/acceptance/projects/' + escAttr(projectId) + '/reviews/' + escAttr(review.id) + '"><div class="toolbar"><div><strong>' + esc(review.manifest?.title || review.subject || review.id) + '</strong><p class="muted">' + esc(review.gate || review.manifest?.gate || "gate") + ' · revision ' + esc(review.revision || 1) + '</p></div>' + stateBadge(review.state) + '</div></a>').join("") + '</div>';
  } catch (error) {
    target.innerHTML = errorState("Review list did not load.", error);
  }
}

function adminEndpoint(mutation, form, body, submitter) {
  const teamId = state.selectedTeamId;
  const projectId = form.dataset.projectId;
  const accountId = form.dataset.accountId || body.accountId;
  if (mutation === "invitation-accept") return { method: "POST", path: api + "/invitations/" + enc(form.dataset.token) + "/accept", body: {} };
  if (mutation === "create-team") return { method: "POST", path: api + "/teams", body };
  if (mutation === "invite") return { method: "POST", path: api + "/teams/" + enc(teamId) + "/invitations", body };
  if (mutation === "owner-transfer") return { method: "POST", path: api + "/teams/" + enc(teamId) + "/transfer", body };
  if (mutation === "team-archive") return { method: "DELETE", path: api + "/teams/" + enc(form.dataset.teamId || teamId), body: {} };
  if (mutation === "team-member") {
    const remove = submitter?.name === "remove";
    return { method: remove ? "DELETE" : "PATCH", path: api + "/teams/" + enc(teamId) + "/members/" + enc(accountId), body: remove ? { reason: "removed_from_acceptance_team" } : { role: body.role } };
  }
  if (mutation === "project-create") return { method: "POST", path: api + "/teams/" + enc(teamId) + "/projects", body };
  if (mutation === "project-settings") {
    const ttlDays = Math.max(1, Math.min(7, Number(body.ttlDays || 7)));
    return { method: "PATCH", path: api + "/projects/" + enc(projectId), body: { name: body.name, enabled: body.enabled === "true", publicRead: Boolean(body.publicRead), quorum: Number(body.quorum || 1), ttlSeconds: ttlDays * 86400 } };
  }
  if (mutation === "project-archive") return { method: "DELETE", path: api + "/projects/" + enc(projectId), body: {} };
  if (mutation === "project-member" || mutation === "project-member-add") {
    const remove = submitter?.name === "remove";
    return { method: remove ? "DELETE" : "PATCH", path: api + "/projects/" + enc(projectId) + "/members/" + enc(accountId), body: remove ? { reason: "removed_from_acceptance_project" } : { role: body.role } };
  }
  if (mutation === "credential-create") return { method: "POST", path: api + "/projects/" + enc(projectId) + "/credentials", body: { name: body.name, scopes: checkedValues(form, "scope") } };
  if (mutation === "credential-delete") return { method: "DELETE", path: api + "/projects/" + enc(projectId) + "/credentials/" + enc(form.dataset.credentialId), body: { reason: "credential_deleted" } };
  if (mutation === "webhook-create") return { method: "POST", path: api + "/projects/" + enc(projectId) + "/integrations/webhooks", body: { url: body.url, description: body.description, events: linesToArray(body.events) } };
  if (mutation === "webhook-save") {
    const remove = submitter?.name === "remove";
    return { method: remove ? "DELETE" : "PATCH", path: api + "/projects/" + enc(projectId) + "/integrations/webhooks/" + enc(form.dataset.webhookId), body: remove ? {} : { enabled: body.enabled === "true" } };
  }
  if (mutation === "github-save") return { method: "PUT", path: api + "/projects/" + enc(projectId) + "/integrations/github", body: { installationId: body.installationId, repositoryId: body.repositoryId, owner: body.owner, name: body.name, allowedWorkflows: linesToArray(body.allowedWorkflows), gates: linesToArray(body.gates), ownershipOidcToken: body.ownershipOidcToken } };
  if (mutation === "github-delete") return { method: "DELETE", path: api + "/projects/" + enc(projectId) + "/integrations/github?repositoryId=" + enc(form.dataset.repositoryId), body: { repositoryId: form.dataset.repositoryId } };
  throw new Error("Unknown acceptance mutation.");
}

function reviewLoading() {
  return '<section class="loading-state"><p class="eyebrow">Review</p><h1>Loading acceptance packet</h1><div class="skeleton wide"></div><div class="skeleton"></div><div class="skeleton short"></div></section>';
}

function reviewShell(review) {
  const manifest = review.manifest || {};
  const policy = review.policy || {};
  const votes = Array.isArray(review.votes) ? review.votes : [];
  const comments = Array.isArray(review.comments) ? review.comments : [];
  const criteria = Array.isArray(manifest.criteria) ? manifest.criteria : [];
  const canReview = Boolean(review.access?.permissions?.review);
  const canManage = Boolean(review.access?.permissions?.manage);
  const currentUserId = review.currentUser?.id;
  const currentVote = currentUserId ? votes.find(vote => vote.actorId === currentUserId) : null;
  const canRecordPreview = Boolean(review.access?.permissions?.read && !review.readOnly);
  const readonly = Boolean(review.readOnly || terminalStates.has(review.state) || !canReview);
  const decisionReadonly = Boolean(readonly || (currentVote && review.state === "pending"));
  const stale = review.expiresAt && Date.parse(review.expiresAt) <= Date.now();
  const ttlDays = Math.round(Number(policy.ttlSeconds || 0) / 86400);
  return '<div class="stack">' +
    '<section class="hero-panel">' +
      '<div class="toolbar"><div><p class="eyebrow">' + esc(manifest.subject || review.subject || "Acceptance review") + '</p><h1>' + esc(manifest.title || review.id) + '</h1></div>' + stateBadge(review.state) + '</div>' +
      '<p class="lede">' + esc(manifest.request || "Review this packet against its criteria before making a decision.") + '</p>' +
      warningNotices(review, stale, readonly, currentVote) +
      '<div class="metric-strip">' +
        metric("Gate", manifest.gate || review.gate || "Unknown") +
        metric("Revision", String(review.revision || 1)) +
        metric("Quorum", String(review.approvalCount ?? votes.filter(v => v.decision === "approve").length) + " / " + String(policy.quorum || 1)) +
        metric("Expires", review.expiresAt ? dateLabel(review.expiresAt) : "No expiry returned") +
      '</div>' +
    '</section>' +
    '<div class="review-grid">' +
      '<div class="stack">' +
        '<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Change under review</h2><p class="panel-note">' + esc(manifest.change || "No change summary returned.") + '</p></div></div>' + buildPanel(manifest, !canRecordPreview) + '</section>' +
        '<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Checklist</h2><p class="panel-note">Approval requires acknowledging every criterion.</p></div></div><div class="criteria-list">' + criteriaList(criteria, decisionReadonly, currentVote?.criteriaIds || []) + '</div></section>' +
        '<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Supporting evidence</h2><p class="panel-note">Review the exact preview and attached evidence before deciding.</p></div></div><div class="evidence-grid">' + evidenceList(manifest.evidence || []) + '</div></section>' +
      '</div>' +
      '<aside class="stack">' +
        '<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Decision</h2><p class="panel-note">' + esc(decisionReadonly ? (currentVote && review.state === "pending" ? "Your approval is recorded; awaiting quorum." : "This review is read-only.") : "Record approval, rejection, or requested revision.") + '</p></div></div>' + decisionForm(criteria, decisionReadonly, currentVote) + '</section>' +
        '<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Discussion</h2><p class="panel-note">Comments do not settle the review.</p></div></div>' + commentForm(readonly) + commentsList(comments) + '</section>' +
        (canManage ? '<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Invalidate review</h2><p class="panel-note">Fails the current gate closed while preserving history.</p></div></div>' + invalidationForm(review.state === "invalidated") + '</section>' : '') +
        '<section class="panel"><div class="panel-header"><div><h2 class="panel-title">Quorum and history</h2><p class="panel-note">Votes use the publication eligibility snapshot.</p></div></div>' + historyList(review, votes) + '</section>' +
      '</aside>' +
    '</div>' +
  '</div>';
}

function buildPanel(manifest, disablePreviewOpen) {
  const build = manifest.build || {};
  const repo = build.repository ? build.repository.owner + "/" + build.repository.name : "External build";
  const assumptions = Array.isArray(build.assumptions) ? build.assumptions : [];
  const components = Array.isArray(build.deployment?.components) ? build.deployment.components : [];
  return '<div class="stack">' +
    '<div class="actions"><button id="open-preview" ' + disabled(disablePreviewOpen) + '>Open exact preview</button><a class="button secondary" href="' + escAttr(build.previewUrl || "#") + '" target="_blank" rel="noopener noreferrer">Preview URL</a></div>' +
    '<div class="metric-strip">' + metric("Repository", repo) + metric("Commit", build.commit || "Unknown") + metric("Provider", build.provider || "Unknown") + metric("Manifest hash", state.review?.manifestHash || "Pending") + '</div>' +
    '<div class="panel-grid"><div>' + subList("Deployment components", components.map(component => (component.name || "component") + " · " + (component.versionId || "unknown"))) + '</div><div>' + subList("Assumptions", assumptions) + '</div></div>' +
    '<p id="preview-status" role="status" class="muted"></p>' +
  '</div>';
}

function invalidationForm(readonly) {
  return '<form id="invalidate-form"><label>Reason<textarea name="reason" required ' + disabled(readonly) + ' placeholder="Deployment rolled back"></textarea></label><button class="danger" ' + disabled(readonly) + '>Invalidate review</button><p id="invalidate-status" role="status" class="muted"></p></form>';
}

function warningNotices(review, stale, readonly, currentVote) {
  const notices = [];
  if (stale || review.state === "expired") notices.push('<div class="notice bad"><strong>Expired</strong><p>This review cannot satisfy a live acceptance gate.</p></div>');
  if (review.state === "superseded") notices.push('<div class="notice warn"><strong>Superseded</strong><p>A newer packet revision replaced this review.</p></div>');
  if (review.state === "invalidated") notices.push('<div class="notice bad"><strong>Invalidated</strong><p>The approval history is retained, but current verification fails closed.</p></div>');
  if (readonly && review.state !== "pending") notices.push('<div class="notice info"><strong>Read-only state</strong><p>Terminal decisions cannot be edited from this page.</p></div>');
  if (currentVote && review.state === "pending") notices.push('<div class="notice info"><strong>Your approval is recorded</strong><p>Awaiting quorum.</p></div>');
  if (!notices.length) notices.push('<div class="notice info"><strong>Reviewer task</strong><p>Open the exact preview, compare it with the checklist, inspect evidence, then record a decision.</p></div>');
  return notices.join("");
}

function criteriaList(criteria, readonly, checkedIds = []) {
  if (!criteria.length) return emptyState("No criteria returned", "The packet cannot be approved until the API returns criteria.");
  const selectedIds = new Set(checkedIds);
  return criteria.map(item => '<label class="criterion"><input type="checkbox" name="criteria" value="' + escAttr(item.id) + '"' + (selectedIds.has(item.id) ? " checked" : "") + (readonly ? " disabled" : "") + '><span><strong>' + esc(item.text || item.id) + '</strong><small>' + esc(item.verification || "No verification instruction supplied.") + '</small></span></label>').join("");
}

function evidenceList(evidence) {
  if (!Array.isArray(evidence) || !evidence.length) return emptyState("No evidence returned", "Reviewers should rely on the exact preview and checklist until evidence is attached.");
  return evidence.map(item => '<article class="evidence-item"><span class="badge">' + esc(item.kind || "evidence") + '</span><strong>' + esc(item.label || item.id) + '</strong>' +
    (item.url ? '<a href="' + escAttr(item.url) + '" target="_blank" rel="noopener noreferrer">' + esc(item.url) + '</a>' : '<span class="evidence-meta">No URL attached</span>') +
    '<span class="evidence-meta">' + esc(item.sha256 ? "sha256 " + item.sha256 : item.contentType || "No digest returned") + '</span></article>').join("");
}

function decisionForm(criteria, readonly, currentVote = null) {
  const currentDecision = currentVote?.decision || "approve";
  return '<form id="decision-form">' +
    '<label>Decision<select name="decision" ' + disabled(readonly) + '>' +
      '<option value="approve"' + selected(currentDecision === "approve") + '>Approve</option><option value="reject"' + selected(currentDecision === "reject") + '>Reject</option><option value="request_revision"' + selected(currentDecision === "request_revision") + '>Request revision</option></select></label>' +
    '<label>Comment<textarea name="comment" ' + disabled(readonly) + '>' + esc(currentVote?.comment || "") + '</textarea></label>' +
    '<button ' + disabled(readonly) + '>Submit decision</button>' +
    '<p id="decision-status" role="status" class="muted"></p>' +
  '</form>';
}

function commentForm(readonly) {
  return '<form id="comment-form"><label>New comment<textarea name="text" ' + disabled(readonly) + ' required></textarea></label><button class="secondary" ' + disabled(readonly) + '>Post comment</button><p id="comment-status" role="status" class="muted"></p></form>';
}

function commentsList(comments) {
  if (!comments.length) return '<div class="state-box"><strong>No discussion yet</strong><p class="muted">Comments will appear here after reviewers post them.</p></div>';
  return '<div class="timeline">' + comments.map(comment => '<div class="timeline-item"><span class="timeline-dot"></span><div class="timeline-card"><strong>' + esc(comment.actorId || "Reviewer") + '</strong><p>' + esc(comment.text || "") + '</p><small>' + esc(dateLabel(comment.createdAt)) + '</small></div></div>').join("") + '</div>';
}

function historyList(review, votes) {
  const events = [
    { actorId: review.publishedBy, decision: "published", createdAt: review.createdAt },
    ...votes,
  ].filter(Boolean);
  if (!events.length) return emptyState("No history returned", "Publication and vote events will appear here.");
  return '<div class="timeline">' + events.map(event => '<div class="timeline-item"><span class="timeline-dot"></span><div class="timeline-card"><strong>' + esc(event.decision || "event") + '</strong><p class="muted">' + esc(event.actorId || "system") + '</p><small>' + esc(dateLabel(event.createdAt)) + '</small></div></div>').join("") + '</div>';
}

function bindReviewControls(review) {
  document.querySelector("#open-preview")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    if (button.disabled) return;
    const status = document.querySelector("#preview-status");
    try {
      button.disabled = true;
      status.textContent = "Recording preview open...";
      await sendJson("POST", api + "/projects/" + enc(review.projectId) + "/reviews/" + enc(review.id) + "/preview-open", {});
      status.textContent = "Preview open recorded.";
      const url = review.manifest?.build?.previewUrl;
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      status.textContent = errorMessage(error);
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#decision-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const status = document.querySelector("#decision-status");
    const criteriaIds = checkedValues(document, "criteria");
    const allCriteria = Array.isArray(review.manifest?.criteria) ? review.manifest.criteria.map(item => item.id) : [];
    try {
      if (form.decision.value === "approve" && criteriaIds.length !== allCriteria.length) throw new Error("Approve requires every criterion to be acknowledged.");
      button.disabled = true;
      status.textContent = "Submitting decision...";
      await sendJson("POST", api + "/projects/" + enc(review.projectId) + "/reviews/" + enc(review.id) + "/decisions", { decision: form.decision.value, comment: form.comment.value.trim(), criteriaIds });
      status.textContent = "Decision submitted.";
      await renderReviewPage(review.projectId, review.id);
    } catch (error) {
      status.textContent = errorMessage(error);
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#comment-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const status = document.querySelector("#comment-status");
    try {
      button.disabled = true;
      status.textContent = "Posting comment...";
      await sendJson("POST", api + "/projects/" + enc(review.projectId) + "/reviews/" + enc(review.id) + "/comments", { text: form.text.value.trim() });
      status.textContent = "Comment posted.";
      await renderReviewPage(review.projectId, review.id);
    } catch (error) {
      status.textContent = errorMessage(error);
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector("#invalidate-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const status = document.querySelector("#invalidate-status");
    try {
      button.disabled = true;
      status.textContent = "Invalidating review...";
      await sendJson("POST", api + "/projects/" + enc(review.projectId) + "/reviews/" + enc(review.id) + "/invalidate", { reason: form.reason.value.trim() });
      status.textContent = "Review invalidated.";
      await renderReviewPage(review.projectId, review.id);
    } catch (error) {
      status.textContent = errorMessage(error);
    } finally {
      button.disabled = false;
    }
  });
}

function recordReviewViewedOnce(review) {
  const projectId = review.projectId;
  const reviewId = review.id;
  const key = projectId + ":" + reviewId;
  if (state.viewedReviewAttempts.has(key)) return;
  state.viewedReviewAttempts.add(key);
  const path = api + "/projects/" + enc(projectId) + "/reviews/" + enc(reviewId) + "/viewed";
  state.viewedReviewKeys[key] = state.viewedReviewKeys[key] || idempotencyKey("POST", path);
  sendJson("POST", path, {}, state.viewedReviewKeys[key]).catch(() => {});
}

async function getJson(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  return parseResponse(response);
}

async function sendJson(method, path, body, key) {
  const response = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "Idempotency-Key": key || idempotencyKey(method, path),
    },
    body: JSON.stringify(body || {}),
  });
  return parseResponse(response);
}

async function sendRaw(method, path, file, contentType, filename) {
  const response = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      "content-type": contentType,
      "X-Nib-Filename": filename,
      "Idempotency-Key": idempotencyKey(method, path),
    },
    body: file,
  });
  return parseResponse(response);
}

async function parseResponse(response) {
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || response.statusText || "Acceptance API request failed.";
    const code = payload?.error?.code ? payload.error.code + ": " : "";
    throw new Error(code + message);
  }
  return payload || {};
}

function idempotencyKey(method, path) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return "nib-ui:" + method + ":" + token;
}

function renderFatal(error) {
  root.innerHTML = errorState("Acceptance workspace failed.", error);
}

function renderError(id, title, error) {
  document.querySelector("#" + id).innerHTML = errorState(title, error);
}

function errorState(title, error) {
  return '<section class="error-state"><p class="eyebrow">Error</p><h1>' + esc(title) + '</h1><p class="lede">' + esc(errorMessage(error)) + '</p><button class="secondary" onclick="location.reload()">Reload</button></section>';
}

function emptyState(title, message) {
  return '<div class="state-box"><strong>' + esc(title) + '</strong><p class="muted">' + esc(message) + '</p></div>';
}

function loadingBlock() {
  return '<section class="panel"><div class="skeleton wide"></div><div class="skeleton"></div><div class="skeleton short"></div></section>';
}

function loadErrorNotices(errors) {
  if (!Array.isArray(errors) || !errors.length) return "";
  return errors.map(message => '<div class="notice warn"><strong>Partial data unavailable</strong><p>' + esc(message) + '</p></div>').join("");
}

function linesToArray(value) {
  return String(value || "").split(/\\r?\\n|,/).map(item => item.trim()).filter(Boolean);
}

function roleOptions(current, roles) {
  return roles.map(role => '<option value="' + escAttr(role) + '"' + selected(role === current) + '>' + esc(role) + '</option>').join("");
}

function stateBadge(value) {
  const state = value || "pending";
  const tone = state === "approved" ? "ok" : state === "pending" ? "info" : state === "rejected" || state === "expired" || state === "invalidated" ? "bad" : "warn";
  return '<span class="badge ' + tone + '">' + esc(state.replace(/_/g, " ")) + '</span>';
}

function metric(label, value) {
  return '<div class="metric"><span>' + esc(label) + '</span><strong>' + esc(String(value ?? "Unknown")) + '</strong></div>';
}

function subList(title, values) {
  if (!values.length) return '<div class="state-box"><strong>' + esc(title) + '</strong><p class="muted">None returned.</p></div>';
  return '<div class="state-box"><strong>' + esc(title) + '</strong><ul>' + values.map(value => '<li>' + esc(value) + '</li>').join("") + '</ul></div>';
}

function checkedValues(scope, name) {
  return Array.from(scope.querySelectorAll('input[name="' + name + '"]:checked')).map(input => input.value);
}

function nearestStatus(form) {
  let status = form.querySelector('[role="status"]');
  if (!status) {
    status = document.createElement("p");
    status.setAttribute("role", "status");
    status.className = "muted";
    form.append(status);
  }
  return status;
}

function setStatus(id, text) {
  const node = document.querySelector("#" + id);
  if (node) node.textContent = text;
}

function dateLabel(value) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return "Not yet";
  const value = Math.max(0, Number(seconds));
  if (!Number.isFinite(value)) return "Not yet";
  if (value < 60) return Math.round(value) + " sec";
  if (value < 3600) return Math.round(value / 60) + " min";
  if (value < 86400) return Math.round(value / 3600) + " hr";
  return Math.round(value / 86400) + " days";
}

function selected(active) { return active ? " selected" : ""; }
function disabled(active) { return active ? " disabled" : ""; }
function enc(value) { return encodeURIComponent(value || ""); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error || "Unknown error"); }
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
function escAttr(value) { return esc(value); }
`;
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) =>
    ({
      "<": "\\u003c",
      ">": "\\u003e",
      "&": "\\u0026",
      "\u2028": "\\u2028",
      "\u2029": "\\u2029",
    })[character]!,
  );
}
