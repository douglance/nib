#[cfg(not(target_arch = "wasm32"))]
use std::path::Path;

use topcoat::{
    Result,
    router::{Router, page},
    view::{View, component, view},
};

#[cfg(not(target_arch = "wasm32"))]
use topcoat::{context::Cx, view::Component};

#[cfg(target_arch = "wasm32")]
use worker::{Context, Env, event};

const CSS: &str = r#"
:root{color-scheme:dark;--bg:#090b0f;--panel:#11151b;--line:#242b35;--muted:#9aa6b5;--text:#f6f8fb;--accent:#d8ff63;--accent-ink:#182000;--blue:#81a7ff}*{box-sizing:border-box}html{scroll-behavior:smooth}body{min-height:100vh;margin:0;display:flex;flex-direction:column;background:radial-gradient(circle at 72% 12%,#19263e 0,transparent 30%),var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.6}main{flex:1}a{color:inherit;text-decoration:none}.shell{width:min(1120px,calc(100% - 40px));margin:auto}.nav{height:76px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ffffff12}.brand{font-weight:760;letter-spacing:-.035em;font-size:1.18rem}.brand-dot{color:var(--accent)}.nav-links{display:flex;align-items:center;gap:24px;color:var(--muted);font-size:.92rem}.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 19px;border:1px solid var(--line);border-radius:12px;font:680 .92rem/1.2 Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.01em;background:#141922;color:var(--text);cursor:pointer}.button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}.hero{display:grid;grid-template-columns:1.02fr .98fr;gap:72px;align-items:center;padding:96px 0 112px}.eyebrow{font:600 .75rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.13em;color:var(--accent)}h1{font-size:clamp(3.4rem,6.25vw,6rem);line-height:.98;letter-spacing:-.05em;margin:26px 0 32px;max-width:720px}.lede{font-size:1.18rem;line-height:1.7;color:var(--muted);max-width:610px}.actions{display:flex;gap:12px;margin-top:38px;flex-wrap:wrap}.micro{margin-top:19px;color:#778394;font-size:.82rem;line-height:1.6}.viewport{position:relative;border:1px solid #364150;border-radius:22px;background:#0d1117;box-shadow:0 35px 100px #0009;overflow:hidden;aspect-ratio:4/3}.viewport img{display:block;width:100%;height:100%;object-fit:cover}.section{padding:100px 0;border-top:1px solid #ffffff12}.section h2{font-size:clamp(2.2rem,4vw,4rem);line-height:1.08;letter-spacing:-.045em;margin:17px 0 26px}.section-copy{color:var(--muted);line-height:1.7;max-width:610px}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:48px}.step,.price{border:1px solid var(--line);border-radius:18px;background:#10141a;padding:26px}.step b{font:600 .75rem/1.4 ui-monospace,monospace;color:var(--blue)}.step h3{margin:34px 0 10px;font-size:1.12rem;line-height:1.3}.step p,.price p{color:var(--muted);font-size:.9rem;line-height:1.65}.install-panel{max-width:900px;margin-top:42px;border:1px solid #465264;border-radius:20px;background:linear-gradient(145deg,#141a22,#0d1117);box-shadow:0 24px 70px #0006;overflow:hidden}.install-panel-head{display:flex;justify-content:space-between;gap:24px;padding:20px 22px;border-bottom:1px solid var(--line);color:var(--muted);font-size:.82rem}.install-panel-head strong{color:var(--text);font-weight:680}.install-prompt{margin:0;padding:26px 28px;white-space:pre-wrap;overflow-wrap:anywhere;color:#eef3fa;font:500 1rem/1.75 ui-monospace,SFMono-Regular,Menlo,monospace}.install-actions{display:flex;align-items:center;gap:12px;padding:0 22px 22px;flex-wrap:wrap}.install-status{min-height:1.4em;margin:0;color:var(--accent);font-size:.82rem}.install-facts{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;max-width:900px;margin-top:28px;color:var(--muted);font-size:.86rem}.install-facts strong{display:block;margin-bottom:6px;color:var(--text);font-size:.95rem}.pricing{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;margin-top:46px;max-width:820px}.price.high{border-color:#a9cf42;box-shadow:inset 0 0 0 1px #a9cf4255}.price-label{font-size:.78rem;color:var(--muted)}.price-amount{font-size:3.2rem;line-height:1.05;letter-spacing:-.04em;margin:16px 0}.price-amount small{font-size:.85rem;letter-spacing:0;color:var(--muted)}.price ul{padding:0;list-style:none;color:#c8d0da;font-size:.9rem;min-height:128px}.price li{margin:10px 0}.price li:before{content:"+";color:var(--accent);margin-right:9px}.price form{margin-top:22px}.price button{width:100%}.footer{display:flex;justify-content:space-between;padding:36px 0 60px;color:#778394;font-size:.82rem}.legal,.docs{max-width:820px;padding:80px 0 120px}.legal h1,.docs h1{font-size:clamp(3rem,7vw,5.5rem)}.legal h2,.docs h2{margin-top:48px}.docs .install-panel{margin:42px 0 64px}.docs pre:not(.install-prompt){overflow:auto;padding:18px 20px;border:1px solid var(--line);border-radius:14px;background:#0d1117;color:#dce6f5;font:500 .88rem/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}.docs code{color:var(--accent)}@media(max-width:820px){.nav-links a:not(.button){display:none}.hero{grid-template-columns:1fr;gap:58px;padding:68px 0 104px}.steps,.pricing,.install-facts{grid-template-columns:1fr}.viewport{max-width:620px}h1{font-size:clamp(3.2rem,14vw,3.75rem);line-height:1;letter-spacing:-.045em}.section{padding:88px 0}.install-panel-head{display:block}.install-panel-head span{display:block;margin-top:5px}.install-prompt{padding:22px;font-size:.9rem}.footer{gap:20px;flex-direction:column}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
"#;

const SIGNUP_CSS: &str = r#"
.signup{max-width:900px;padding:80px 0 120px}.signup h1{font-size:clamp(3rem,7vw,5.5rem)}.credential-panel{margin-top:42px;padding:30px;border:1px solid var(--line);border-radius:20px;background:linear-gradient(145deg,#141a22,#0d1117)}.credential-panel[hidden]{display:none}.credential-panel h2{margin:0 0 12px;font-size:1.4rem}.token-value{display:block;margin:22px 0;padding:18px 20px;overflow-wrap:anywhere;border:1px solid #a9cf4266;border-radius:14px;background:#090b0f;color:var(--accent);font:600 .9rem/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}.credential-actions{display:flex;gap:12px;flex-wrap:wrap}.credential-plans{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:30px}.credential-plans form,.credential-plans button{width:100%}.credential-note{color:var(--muted);font-size:.88rem}.credential-status{min-height:1.4em;color:var(--accent);font-size:.85rem}.signup .button{margin-top:8px}@media(max-width:680px){.credential-panel{padding:22px}.credential-plans{grid-template-columns:1fr}.token-value{font-size:.78rem}}
"#;

const INSTALL_PROMPT: &str = r#"Install Nib for me. Follow https://nib.doug-lance.workers.dev/install-agent.md exactly. Configure it globally for this agent, install the Nib UI image skill globally, add the managed Nib instruction to this agent's global instruction file, preserve my existing settings, and verify that the generate_ui tool is available without generating an image."#;

const SEO_JSON_LD: &str = r#"{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://nib.doug-lance.workers.dev/#website",
      "url": "https://nib.doug-lance.workers.dev/",
      "name": "Nib",
      "description": "A UI image generator for AI agents and developer tools."
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://nib.doug-lance.workers.dev/#software",
      "name": "Nib",
      "url": "https://nib.doug-lance.workers.dev/",
      "applicationCategory": "DeveloperApplication",
      "operatingSystem": "Any",
      "description": "Generate one user-interface image from a text prompt and optional reference images for AI agents and developer tools.",
      "featureList": [
        "Generate one UI image from a text prompt",
        "Accept up to three PNG, JPEG, or WebP reference images",
        "Return a PNG or JPEG through MCP, CLI, HTTP, or OpenAPI"
      ],
      "offers": [
        {
          "@type": "Offer",
          "name": "Free trial",
          "price": "0",
          "priceCurrency": "USD",
          "description": "One eligible Fast 1K UI image after creating a free account"
        },
        {
          "@type": "Offer",
          "name": "Default",
          "price": "9.99",
          "priceCurrency": "USD",
          "description": "$9.99 per month plus metered image-generation usage"
        },
        {
          "@type": "Offer",
          "name": "High",
          "price": "29.99",
          "priceCurrency": "USD",
          "description": "$29.99 per month plus metered image-generation usage"
        }
      ]
    }
  ]
}"#;

/// Builds the dynamic Topcoat router used in the Cloudflare Worker.
pub fn router() -> Router {
    Router::builder()
        .page(home)
        .page(docs)
        .page(pricing_page)
        .page(privacy)
        .page(terms)
        .page(account)
        .page(signup)
        .build()
}

/// Bridges the Cloudflare Workers HTTP event directly into Topcoat's
/// platform-neutral serverless router.
#[cfg(target_arch = "wasm32")]
#[event(fetch)]
pub async fn fetch(
    request: http::Request<worker::Body>,
    _env: Env,
    _context: Context,
) -> worker::Result<http::Response<topcoat::router::Body>> {
    let mut response = router()
        .handle(request.map(topcoat::router::Body::new))
        .await;
    response.headers_mut().insert(
        "x-nib-renderer",
        http::HeaderValue::from_static("topcoat-wasm-worker"),
    );
    Ok(response)
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn export_site(output: &Path) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let cx = Cx::default();
    let pages = [
        (
            "index.html",
            home.render(&cx, HomeProps {}).await.map_err(render_error)?,
        ),
        (
            "docs/index.html",
            docs.render(&cx, DocsProps {}).await.map_err(render_error)?,
        ),
        (
            "pricing/index.html",
            pricing_page
                .render(&cx, PricingPageProps {})
                .await
                .map_err(render_error)?,
        ),
        (
            "privacy/index.html",
            privacy
                .render(&cx, PrivacyProps {})
                .await
                .map_err(render_error)?,
        ),
        (
            "terms/index.html",
            terms
                .render(&cx, TermsProps {})
                .await
                .map_err(render_error)?,
        ),
        (
            "account/index.html",
            account
                .render(&cx, AccountProps {})
                .await
                .map_err(render_error)?,
        ),
        (
            "signup/index.html",
            signup
                .render(&cx, SignupProps {})
                .await
                .map_err(render_error)?,
        ),
    ];
    for (relative, page) in pages {
        let destination = output.join(relative);
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(destination, page.render(&Cx::default())).await?;
    }

    let assets = output.join("assets");
    tokio::fs::create_dir_all(&assets).await?;
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    tokio::fs::copy(
        source.join("generated-ui-hero.png"),
        assets.join("generated-ui-hero.png"),
    )
    .await?;
    tokio::fs::copy(source.join("install.js"), assets.join("install.js")).await?;
    tokio::fs::copy(
        source.join("credential.js"),
        assets.join("credential.js"),
    )
    .await?;
    Ok(())
}

#[cfg(not(target_arch = "wasm32"))]
fn render_error(error: topcoat::Error) -> std::io::Error {
    std::io::Error::other(format!("Topcoat render failed: {error:?}"))
}

#[page("/")]
async fn home() -> Result {
    view! {
        page_document(
            title: "UI image generator for AI agents | Nib",
            description: "Generate a UI image from a prompt and optional references. Use Nib when your model, coding agent, or workflow can describe an interface but cannot render it.",
            canonical: "https://nib.doug-lance.workers.dev/",
            <main>
                <section class="shell hero">
                    <div>
                        <div class="eyebrow">"UI image generator"</div>
                        <h1>"Generate a UI image from a prompt."</h1>
                        <p class="lede">"Describe the dashboard, app screen, landing page, or interface you need. Nib returns one finished PNG or JPEG, even when the model or agent you are using cannot generate images."</p>
                        <div class="actions">
                            <a class="button primary" href="#agents">"Install Nib free"</a>
                            <a class="button" href="#how">"See how it works"</a>
                        </div>
                        <p class="micro">"Paste one prompt into your agent. No card. One eligible Fast 1K UI image is free after creating an account."</p>
                    </div>
                    ui_viewport()
                </section>
                how_it_works()
                agent_connection()
                pricing()
            </main>
        )
    }
}

#[page("/pricing")]
async fn pricing_page() -> Result {
    view! {
        page_document(
            title: "UI image generation pricing | Nib",
            description: "Pricing for the Nib UI image generator. Try one eligible Fast 1K image free, then choose a plan and pay for generation usage.",
            canonical: "https://nib.doug-lance.workers.dev/pricing",
            <main>pricing()</main>
        )
    }
}

#[page("/privacy")]
async fn privacy() -> Result {
    view! { legal_document(title: "Privacy", canonical: "https://nib.doug-lance.workers.dev/privacy", copy: "Prompts are not written to the product database. AI Gateway request and response logging is disabled. Reference images are temporary and deleted after generation. Generated artifacts are private and retained for 1 day on the free trial, 7 days on Default, or 30 days on High. Trial abuse state stores a keyed network-cohort hash instead of the source IP address.") }
}

#[page("/terms")]
async fn terms() -> Result {
    view! { legal_document(title: "Terms", canonical: "https://nib.doug-lance.workers.dev/terms", copy: "Nib provides one Fast 1K trial image to an eligible account without a card. Continued use requires a subscription, and subscription fees do not include generation usage. Each paid generation is metered at the published rate for its quality and resolution. You must have rights to every reference image you submit.") }
}

#[page("/account")]
async fn account() -> Result {
    view! {
        page_document(
            title: "Nib account",
            description: "Manage your Nib subscription and UI image generation plan.",
            canonical: "https://nib.doug-lance.workers.dev/account",
            <main class="shell legal">
                <div class="eyebrow">"Account"</div>
                <h1>"Manage Nib."</h1>
                <p class="lede">"Use the billing portal to change or cancel your plan. If you just completed checkout, generation access becomes active after Stripe confirms the subscription."</p>
                <div class="actions">
                    <form method="post" action="/billing/portal">
                        <button class="button primary" type="submit">"Open billing portal"</button>
                    </form>
                    <a class="button" href="/docs">"Read the quick start"</a>
                    <form method="post" action="/auth/credentials/rotate">
                        <button class="button" type="submit">"Rotate access token"</button>
                    </form>
                    <form method="post" action="/auth/logout">
                        <button class="button" type="submit">"Sign out"</button>
                    </form>
                </div>
            </main>
        )
    }
}

#[page("/signup")]
async fn signup() -> Result {
    view! {
        page_document(
            title: "Create a Nib account",
            description: "Create a free Nib account, save your revocable access token, and generate your first eligible Fast 1K UI image without a card.",
            canonical: "https://nib.doug-lance.workers.dev/signup",
            <main class="shell signup">
                <section data-signup-panel="">
                    <div class="eyebrow">"One free Fast 1K image"</div>
                    <h1>"Create your Nib access token."</h1>
                    <p class="lede">"Start without an email or card. Nib creates a private browser session and a revocable token for your CLI or agent."</p>
                    <form method="post" action="/auth/signup">
                        <button class="button primary" type="submit">"Create free account"</button>
                    </form>
                    <p class="micro">"Your token is shown once. Save it in your password manager before leaving this page."</p>
                </section>
                <section class="credential-panel" data-token-panel="" hidden="">
                    <div class="eyebrow">"Account ready"</div>
                    <h2>"Save your access token now."</h2>
                    <p class="credential-note">"Nib stores only its hash and cannot show this token again. Rotating it revokes the old value."</p>
                    <code class="token-value" data-token-value="" tabindex="0"></code>
                    <div class="credential-actions">
                        <button class="button primary" type="button" data-copy-token="">"Copy token"</button>
                        <a class="button" href="/docs">"Connect an agent"</a>
                        <a class="button" href="/account">"Open account"</a>
                    </div>
                    <p class="credential-status" data-token-status="" aria-live="polite"></p>
                    <h2>"Need more than the free image?"</h2>
                    <div class="credential-plans">
                        <form method="post" action="/billing/checkout">
                            <input type="hidden" name="plan" value="default">
                            <button class="button" type="submit">"Subscribe to Default - $9.99/mo"</button>
                        </form>
                        <form method="post" action="/billing/checkout">
                            <input type="hidden" name="plan" value="high">
                            <button class="button primary" type="submit">"Subscribe to High - $29.99/mo"</button>
                        </form>
                    </div>
                    <p class="micro">"Subscriptions exclude metered generation usage. Stripe shows the exact recurring charge before payment."</p>
                </section>
            </main>
        )
    }
}

#[page("/docs")]
async fn docs() -> Result {
    view! {
        page_document(
            title: "Generate UI images with MCP, CLI, or API | Nib",
            description: "Connect an AI agent to the Nib UI image generator with MCP, CLI, HTTP, OpenAPI, or an installable skill.",
            canonical: "https://nib.doug-lance.workers.dev/docs",
            <main class="shell docs">
                <div class="eyebrow">"Connect the image tool"</div>
                <h1>"Give your agent UI image generation."</h1>
                <p class="lede">"Choose the interface your agent can call. Every option accepts the same UI brief and returns one generated image. Install or discover the tool for free, then authenticate when the agent generates."</p>
                install_prompt()
                <h2 id="authentication">"Authenticate on the first image"</h2>
                <p>"Create a free account, save the access token shown once, and export it for the CLI or local MCP server. Nib stores only a SHA-256 hash, and rotating the credential from your account revokes the prior token."</p>
                <pre>"export NIB_ACCESS_TOKEN=\"nib_live_...\""</pre>
                <h2>"CLI"</h2>
                <pre>"nib generate \"A compact dark analytics dashboard for a fleet operator\" \\\n  --quality fast --resolution 1K --aspect 16:9 \\\n  --image-format png --output dashboard.png"</pre>
                <h2 id="mcp">"MCP"</h2>
                <p>"For local stdio MCP, run " <code>"nib --mcp"</code> " with " <code>"NIB_ACCESS_TOKEN"</code> " set. A Streamable HTTP client connects to " <code>"https://nib.doug-lance.workers.dev/mcp"</code> " without authentication for installation and tool discovery. Before the first image, add the Nib token as an " <code>"Authorization: Bearer"</code> " credential. The server exposes exactly one tool: " <code>"generate_ui"</code> "."</p>
                <pre>"{\n  \"prompt\": \"A calm account settings screen\",\n  \"references\": [],\n  \"quality\": \"fast\",\n  \"aspect\": \"16:9\",\n  \"resolution\": \"1K\",\n  \"format\": \"png\",\n  \"background\": false\n}"</pre>
                <h2>"Agent discovery"</h2>
                <p>"The OpenAPI document and installable skill are public. Authentication is required only when the agent calls the generation tool."</p>
                <pre>"https://nib.doug-lance.workers.dev/openapi.json\nhttps://nib.doug-lance.workers.dev/.well-known/skills/generate/SKILL.md"</pre>
                <h2>"References"</h2>
                <p>"Pass up to three PNG, JPEG, or WebP files with repeated " <code>"--ref"</code> " options. Nib deletes temporary references after the generation attempt."</p>
            </main>
        )
    }
}

#[component]
async fn page_document(title: &str, description: &str, canonical: &str, child: View) -> Result {
    view! {
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta name="description" content=(description)>
                <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">
                <link rel="canonical" href=(canonical)>
                <meta property="og:type" content="website">
                <meta property="og:site_name" content="Nib">
                <meta property="og:title" content=(title)>
                <meta property="og:description" content=(description)>
                <meta property="og:url" content=(canonical)>
                <meta name="twitter:card" content="summary">
                <meta name="twitter:title" content=(title)>
                <meta name="twitter:description" content=(description)>
                <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23141922'/%3E%3Ccircle cx='16' cy='16' r='7' fill='%23d8ff63'/%3E%3C/svg%3E">
                <title>(title)</title>
                <script type="application/ld+json">(SEO_JSON_LD)</script>
                <script src="/assets/install.js" defer="defer"></script>
                <script src="/assets/credential.js" defer="defer"></script>
                <style>(CSS)</style>
                <style>(SIGNUP_CSS)</style>
            </head>
            <body>
                site_nav()
                (child)
                site_footer()
            </body>
        </html>
    }
}

#[component]
async fn site_nav() -> Result {
    view! {
        <header class="shell nav">
            <a class="brand" href="/">"nib" <span class="brand-dot">"."</span></a>
            <nav class="nav-links" aria-label="Primary navigation">
                <a href="/#agents">"For agents"</a>
                <a href="/#pricing">"Pricing"</a>
                <a href="/account">"Account"</a>
                <a class="button" href="/signup">"Start free"</a>
            </nav>
        </header>
    }
}

#[component]
async fn ui_viewport() -> Result {
    view! {
        <div class="viewport">
            <img src="/assets/generated-ui-hero.png" alt="Dark Nib dashboard showing API requests, compute hours, a generation-volume chart, and recent image jobs.">
        </div>
    }
}

#[component]
async fn how_it_works() -> Result {
    view! {
        <section class="section" id="how"><div class="shell">
            <div class="eyebrow">"One job"</div><h2>"Describe the interface. Get the image."</h2>
            <p class="section-copy">"Use Nib to turn a dashboard, settings screen, mobile app, landing page, or another user interface into an image. It accepts the brief and returns one generated viewport."</p>
            <div class="steps">
                <article class="step"><b>"01 / FIND"</b><h3>"Choose the image tool"</h3><p>"Nib is public and discoverable before you create an account or provide payment details."</p></article>
                <article class="step"><b>"02 / SEND"</b><h3>"Describe the interface"</h3><p>"Send the screen, content, hierarchy, style, and constraints. Add up to three references when they guide the result."</p></article>
                <article class="step"><b>"03 / GET"</b><h3>"Receive one image"</h3><p>"Nib returns a PNG or JPEG to save, show, or use in the next task."</p></article>
            </div>
        </div></section>
    }
}

#[component]
async fn agent_connection() -> Result {
    view! {
        <section class="section" id="agents"><div class="shell">
            <div class="eyebrow">"Install from your agent"</div>
            <h2>"Paste one prompt. Your agent does the setup."</h2>
            <p class="section-copy">"Paste the prompt into Codex, Claude Code, Gemini CLI, or another coding agent. It connects the remote MCP tool globally, installs the Nib skill, and teaches the root agent when to use it."</p>
            install_prompt()
            <div class="install-facts" aria-label="Installation results">
                <div><strong>"One remote tool"</strong>"Your agent gets " <code>"generate_ui"</code> " without a local model or API key."</div>
                <div><strong>"One focused skill"</strong>"The skill triggers only when the task needs a generated UI image."</div>
                <div><strong>"One managed instruction"</strong>"Existing agent instructions stay intact and the Nib block is added once."</div>
            </div>
        </div></section>
    }
}

#[component]
async fn install_prompt() -> Result {
    view! {
        <div class="install-panel">
            <div class="install-panel-head">
                <strong>"Paste this into your agent"</strong>
                <span>"Codex / Claude Code / Gemini CLI / MCP agents"</span>
            </div>
            <pre class="install-prompt" id="install-prompt" tabindex="0">(INSTALL_PROMPT)</pre>
            <div class="install-actions">
                <button class="button primary" type="button" data-copy-install="" aria-describedby="install-status">"Copy install prompt"</button>
                <a class="button" href="/install-agent.md">"Review installation steps"</a>
                <p class="install-status" id="install-status" aria-live="polite"></p>
            </div>
        </div>
    }
}

#[component]
async fn pricing() -> Result {
    view! {
        <section class="section" id="pricing"><div class="shell">
            <div class="eyebrow">"Try one UI image free"</div><h2>"Start when you need the image."</h2>
            <p class="section-copy">"Generate one eligible Fast 1K UI image after creating an account without a card. Subscribe only when you need continued generation, higher quality, or more concurrent jobs."</p>
            <div class="pricing">
                price_card(name: "Default", amount: "$9.99", plan: "default", high: false, features: &["2 active generations", "20 queued jobs", "60 requests per minute", "7-day artifact retention"])
                price_card(name: "High", amount: "$29.99", plan: "high", high: true, features: &["8 active generations", "100 queued jobs", "300 requests per minute", "30-day artifact retention", "4x scheduling weight"])
            </div>
            <p class="micro">"First eligible Fast 1K image: free. Paid generation rates: fast 1K $0.12; standard $0.22 / $0.32 / $0.48; pro $0.43 / $0.43 / $0.75. Subscriptions have no included credits or usage cap."</p>
        </div></section>
    }
}

#[component]
async fn price_card(
    name: &'static str,
    amount: &'static str,
    plan: &'static str,
    high: bool,
    features: &'static [&'static str],
) -> Result {
    view! {
        <article class=(if high { "price high" } else { "price" })>
            <div class="price-label">(name)</div><div class="price-amount">(amount) <small>"/ month"</small></div>
            <p>"Plus uncapped metered generation usage."</p>
            <ul>for feature in features { <li>(feature)</li> }</ul>
            <a class=(if high { "button primary" } else { "button" }) href=(format!("/signup?plan={plan}"))>"Choose " (name)</a>
        </article>
    }
}

#[component]
async fn site_footer() -> Result {
    view! { <footer class="shell footer"><span>"Nib - UI image generation from one prompt."</span><span><a href="https://github.com/douglance/nib">"Apache-2.0 source"</a> "  /  " <a href="/privacy">"Privacy"</a> "  /  " <a href="/terms">"Terms"</a></span></footer> }
}

#[component]
async fn legal_document(
    title: &'static str,
    canonical: &'static str,
    copy: &'static str,
) -> Result {
    view! {
        page_document(
            title: title,
            description: copy,
            canonical: canonical,
            <main class="shell legal"><div class="eyebrow">"Legal"</div><h1>(title)</h1><p class="lede">(copy)</p></main>
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::{Request, StatusCode};
    use topcoat::router::{Body, to_bytes};

    #[tokio::test]
    async fn router_renders_every_site_page() {
        for path in ["/", "/docs", "/pricing", "/privacy", "/terms", "/account", "/signup"] {
            let response = router()
                .handle(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await;
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            assert_eq!(
                response.headers().get("content-type").unwrap(),
                "text/html; charset=utf-8",
                "{path}"
            );
            let html = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert!(html.starts_with(b"<!DOCTYPE html>"), "{path}");
        }
    }
}
