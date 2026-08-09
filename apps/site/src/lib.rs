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
:root{color-scheme:dark;--bg:#090b0f;--panel:#11151b;--panel-strong:#151b24;--line:#242b35;--muted:#9aa6b5;--text:#f6f8fb;--accent:#d8ff63;--accent-ink:#182000;--blue:#81a7ff;--focus:#f4ff9d}*{box-sizing:border-box}html{scroll-behavior:smooth}body{min-height:100vh;margin:0;display:flex;flex-direction:column;background:radial-gradient(circle at 72% 12%,#19263e 0,transparent 30%),var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.6}main{flex:1}a{color:inherit;text-decoration:none}a:focus-visible,button:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--focus);outline-offset:3px}.shell{width:min(1120px,calc(100% - 40px));margin:auto}.nav{height:76px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #ffffff12}.brand{font-weight:760;letter-spacing:-.035em;font-size:1.18rem}.brand-dot{color:var(--accent)}.nav-links{display:flex;align-items:center;gap:24px;color:var(--muted);font-size:.92rem}.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 19px;border:1px solid var(--line);border-radius:12px;font:680 .92rem/1.2 Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.01em;background:#141922;color:var(--text);cursor:pointer}.button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}.hero{display:grid;grid-template-columns:1.02fr .98fr;gap:72px;align-items:center;padding:96px 0 112px}.eyebrow{font:600 .75rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.13em;color:var(--accent)}h1{font-size:clamp(3.4rem,6.25vw,6rem);line-height:.98;letter-spacing:-.05em;margin:26px 0 32px;max-width:760px;text-wrap:balance}.lede{font-size:1.18rem;line-height:1.7;color:var(--muted);max-width:650px;text-wrap:pretty}.actions{display:flex;gap:12px;margin-top:38px;flex-wrap:wrap}.micro{margin-top:19px;color:#778394;font-size:.82rem;line-height:1.6}.viewport{position:relative;border:1px solid #364150;border-radius:22px;background:#0d1117;box-shadow:0 35px 100px #0009;overflow:hidden;aspect-ratio:4/3}.viewport img{display:block;width:100%;height:100%;object-fit:cover}.section{padding:100px 0;border-top:1px solid #ffffff12}.section h2{font-size:clamp(2.2rem,4vw,4rem);line-height:1.08;letter-spacing:-.045em;margin:17px 0 26px;text-wrap:balance}.section-copy{color:var(--muted);line-height:1.7;max-width:650px;text-wrap:pretty}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:48px}.step{border:1px solid var(--line);border-radius:18px;background:#10141a;padding:26px}.step b{font:600 .75rem/1.4 ui-monospace,monospace;color:var(--blue)}.step h3{margin:34px 0 10px;font-size:1.12rem;line-height:1.3}.step p,.price-card p{color:var(--muted);font-size:.9rem;line-height:1.65}.install-panel{max-width:900px;margin-top:42px;border:1px solid #465264;border-radius:20px;background:linear-gradient(145deg,#141a22,#0d1117);box-shadow:0 24px 70px #0006;overflow:hidden}.install-panel-head{display:flex;justify-content:space-between;gap:24px;padding:20px 22px;border-bottom:1px solid var(--line);color:var(--muted);font-size:.82rem}.install-panel-head strong{color:var(--text);font-weight:680}.install-prompt{margin:0;padding:26px 28px;white-space:pre-wrap;overflow-wrap:anywhere;color:#eef3fa;font:500 1rem/1.75 ui-monospace,SFMono-Regular,Menlo,monospace}.install-actions{display:flex;align-items:center;gap:12px;padding:0 22px 22px;flex-wrap:wrap}.install-status{min-height:1.4em;margin:0;color:var(--accent);font-size:.82rem}.install-facts,.free-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;max-width:900px;margin-top:28px;color:var(--muted);font-size:.86rem}.install-facts strong,.free-grid strong{display:block;margin-bottom:6px;color:var(--text);font-size:.95rem}.pricing-layout{display:grid;grid-template-columns:.55fr 1.45fr;gap:18px;align-items:start;margin-top:46px}.pricing-callout,.pricing-table-wrap,.price-card{border:1px solid var(--line);border-radius:18px;background:#10141a}.pricing-callout{padding:28px;background:linear-gradient(160deg,#151b24,#0f1319)}.pricing-callout .price-amount{font-size:3.5rem}.price-kicker{font:600 .75rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}.price-amount{font-size:3rem;line-height:1.05;letter-spacing:-.04em;margin:14px 0}.price-amount small{font-size:.85rem;letter-spacing:0;color:var(--muted)}.pricing-note{margin:24px 0 0;color:#c8d0da;font-size:.9rem;line-height:1.7}.pricing-table-wrap{overflow:hidden}.pricing-table{width:100%;border-collapse:collapse;font-size:.9rem}.pricing-table th,.pricing-table td{padding:16px 18px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}.pricing-table th{color:var(--muted);font:600 .72rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.12em;background:#131821}.pricing-table tr:last-child td{border-bottom:0}.pricing-table strong{display:block;color:var(--text);font-size:1rem}.pricing-table small{display:block;color:var(--muted);line-height:1.5}.pricing-table .amount{font-weight:760;color:var(--text)}.pricing-table .button{white-space:nowrap}.checkout-cell{width:178px}.checkout-pending{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border:1px solid #39424f;border-radius:10px;color:#9aa6b5;background:#11151b;font-size:.78rem;font-weight:680}.configured-plans{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;margin-top:18px;max-width:820px}.price-card{padding:24px}.price-card.high{border-color:#a9cf42;box-shadow:inset 0 0 0 1px #a9cf4255}.price-card ul{padding:0;list-style:none;color:#c8d0da;font-size:.9rem;min-height:96px}.price-card li{margin:10px 0}.price-card li:before{content:"+";color:var(--accent);margin-right:9px}.price-card .button{width:100%}.footer{display:flex;justify-content:space-between;padding:36px 0 60px;color:#778394;font-size:.82rem}.legal,.docs{max-width:820px;padding:80px 0 120px}.legal h1,.docs h1{font-size:clamp(3rem,7vw,5.5rem)}.legal h2,.docs h2{margin-top:48px}.docs .install-panel{margin:42px 0 64px}.docs pre:not(.install-prompt){overflow:auto;padding:18px 20px;border:1px solid var(--line);border-radius:14px;background:#0d1117;color:#dce6f5;font:500 .88rem/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}.docs code{color:var(--accent)}@media(max-width:980px){.pricing-layout{grid-template-columns:1fr}.checkout-cell{width:auto}}@media(max-width:820px){.nav-links a:not(.button){display:none}.hero{grid-template-columns:1fr;gap:58px;padding:68px 0 104px}.steps,.install-facts,.free-grid,.configured-plans{grid-template-columns:1fr}.viewport{max-width:620px}h1{font-size:clamp(3.05rem,13vw,3.75rem);line-height:1;letter-spacing:-.045em}.section{padding:88px 0}.install-panel-head{display:block}.install-panel-head span{display:block;margin-top:5px}.install-prompt{padding:22px;font-size:.9rem}.pricing-table,.pricing-table tbody,.pricing-table tr,.pricing-table td{display:block}.pricing-table thead{display:none}.pricing-table tr{padding:16px 18px;border-bottom:1px solid var(--line)}.pricing-table tr:last-child{border-bottom:0}.pricing-table td{padding:5px 0;border:0}.pricing-table td:before{content:attr(data-label);display:block;margin-bottom:1px;color:var(--muted);font:600 .67rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.12em}.footer{gap:20px;flex-direction:column}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
"#;

const SIGNUP_CSS: &str = r#"
.signup{max-width:900px;padding:80px 0 120px}.signup h1{font-size:clamp(3rem,7vw,5.5rem)}.credential-panel{margin-top:42px;padding:30px;border:1px solid var(--line);border-radius:20px;background:linear-gradient(145deg,#141a22,#0d1117)}.credential-panel[hidden]{display:none}.credential-panel h2{margin:0 0 12px;font-size:1.4rem}.token-value{display:block;margin:22px 0;padding:18px 20px;overflow-wrap:anywhere;border:1px solid #a9cf4266;border-radius:14px;background:#090b0f;color:var(--accent);font:600 .9rem/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}.credential-actions{display:flex;gap:12px;flex-wrap:wrap}.credential-plans{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:30px}.credential-plans form,.credential-plans button{width:100%}.credential-note{color:var(--muted);font-size:.88rem}.credential-status{min-height:1.4em;color:var(--accent);font-size:.85rem}.signup .button{margin-top:8px}@media(max-width:680px){.credential-panel{padding:22px}.credential-plans{grid-template-columns:1fr}.token-value{font-size:.78rem}}
"#;

const INSTALL_PROMPT: &str = r#"Install Nib for me. Follow https://nibtool.com/install-agent.md exactly. Configure it globally for this agent, install the Nib UI image skill globally, add the managed Nib instruction to this agent's global instruction file, preserve my existing settings, and verify that the generate_ui tool is available without generating an image."#;

const SEO_JSON_LD: &str = r#"{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://nibtool.com/#website",
      "url": "https://nibtool.com/",
      "name": "Nib",
      "description": "The fastest way for humans to review AI-generated software."
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://nibtool.com/#software",
      "name": "Nib",
      "url": "https://nibtool.com/",
      "applicationCategory": "DeveloperApplication",
      "operatingSystem": "Any",
      "description": "Create hosted human review requests for AI-generated software. Tests verify behavior. Nib verifies intent.",
      "featureList": [
        "Create hosted review requests from agents and developer tools",
        "Invite guest participants without paid seats",
        "Use repositories and self-hosted review flows for free"
      ],
      "offers": [
        {
          "@type": "Offer",
          "name": "Free",
          "price": "0",
          "priceCurrency": "USD",
          "description": "25 hosted requests and one Fast 1K trial with no overage"
        },
        {
          "@type": "Offer",
          "name": "Starter",
          "price": "9",
          "priceCurrency": "USD",
          "description": "100 hosted requests, $5 generation credit, then $0.05 per hosted request overage"
        },
        {
          "@type": "Offer",
          "name": "Pro",
          "price": "24",
          "priceCurrency": "USD",
          "description": "500 hosted requests, $20 generation credit, then $0.05 per hosted request overage"
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
    tokio::fs::copy(source.join("credential.js"), assets.join("credential.js")).await?;
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
            title: "Human review for AI-generated software | Nib",
            description: "The fastest way for humans to review AI-generated software. Tests verify behavior. Nib verifies intent.",
            canonical: "https://nibtool.com/",
            <main>
                <section class="shell hero">
                    <div>
                        <div class="eyebrow">"Human review for AI software"</div>
                        <h1>"The fastest way for humans to review AI-generated software"</h1>
                        <p class="lede">"Tests verify behavior. Nib verifies intent. Create hosted review requests from the agent that made the change, invite the right people, and keep the approval trail attached to the work."</p>
                        <div class="actions">
                            <a class="button primary" href="/signup">"Start free"</a>
                            <a class="button" href="#pricing">"See pricing"</a>
                        </div>
                        <p class="micro">"Reviewing, guest participants, repositories, and self-hosted use are free. Hosted request volume is the paid meter."</p>
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
            title: "Human review pricing | Nib",
            description: "Nib pricing for hosted human review requests. Free reviewing, guest participants, repositories, and self-hosted use stay free.",
            canonical: "https://nibtool.com/pricing",
            <main>pricing()</main>
        )
    }
}

#[page("/privacy")]
async fn privacy() -> Result {
    view! { legal_document(title: "Privacy", canonical: "https://nibtool.com/privacy", copy: "Prompts are not written to the product database. AI Gateway request and response logging is disabled. Reference images are temporary and deleted after generation. Generated artifacts are private and retained for 1 day on the free trial, 7 days on Starter, or 30 days on Pro. Trial abuse state stores a keyed network-cohort hash instead of the source IP address.") }
}

#[page("/terms")]
async fn terms() -> Result {
    view! { legal_document(title: "Terms", canonical: "https://nibtool.com/terms", copy: "Nib provides a free plan for hosted review requests and one Fast 1K generation trial to an eligible account without a card. Paid plans include the published hosted request allowance and generation credit; hosted request overage is billed at the published rate for the plan. Allowances reset each billing month and do not roll over. You must have rights to every artifact, repository, or reference image you submit.") }
}

#[page("/account")]
async fn account() -> Result {
    view! {
        page_document(
            title: "Nib account",
            description: "Manage your Nib subscription and hosted human review plan.",
            canonical: "https://nibtool.com/account",
            <main class="shell legal">
                <div class="eyebrow">"Account"</div>
                <h1>"Manage Nib."</h1>
                <p class="lede">"Use the billing portal to change or cancel your plan. If you just completed checkout, hosted request capacity becomes active after Stripe confirms the subscription."</p>
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
            description: "Create a free Nib account, save your revocable access token, and start reviewing AI-generated software.",
            canonical: "https://nibtool.com/signup",
            <main class="shell signup">
                <section data-signup-panel="">
                    <div class="eyebrow">"Free hosted reviews"</div>
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
                    <h2>"Need more hosted request volume?"</h2>
                    <div class="credential-plans">
                        <form method="post" action="/billing/checkout">
                            <input type="hidden" name="plan" value="default">
                            <button class="button" type="submit">"Subscribe to Starter - $9/mo"</button>
                        </form>
                        <form method="post" action="/billing/checkout">
                            <input type="hidden" name="plan" value="high">
                            <button class="button primary" type="submit">"Subscribe to Pro - $24/mo"</button>
                        </form>
                    </div>
                    <p class="micro">"Starter and Pro checkout are configured now. Other tiers are listed on pricing until checkout is configured."</p>
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
            canonical: "https://nibtool.com/docs",
            <main class="shell docs">
                <div class="eyebrow">"Connect the review tool"</div>
                <h1>"Give your agent a human review path."</h1>
                <p class="lede">"Use Nib when generated software needs a person to judge whether the change matches intent. The UI image tool remains available for visual artifacts, and hosted review requests are metered separately from free reviewing."</p>
                install_prompt()
                <h2 id="authentication">"Authenticate on the first image"</h2>
                <p>"Create a free account, save the access token shown once, and export it for the CLI or local MCP server. Nib stores only a SHA-256 hash, and rotating the credential from your account revokes the prior token."</p>
                <pre>"export NIB_ACCESS_TOKEN=\"nib_live_...\""</pre>
                <h2>"CLI"</h2>
                <pre>"nib generate \"A compact dark analytics dashboard for a fleet operator\" \\\n  --quality fast --resolution 1K --aspect 16:9 \\\n  --image-format png --output dashboard.png"</pre>
                <h2 id="mcp">"MCP"</h2>
                <p>"For local stdio MCP, run " <code>"nib --mcp"</code> " with " <code>"NIB_ACCESS_TOKEN"</code> " set. A Streamable HTTP client connects to " <code>"https://nibtool.com/mcp"</code> " without authentication for installation and tool discovery. Before the first image, add the Nib token as an " <code>"Authorization: Bearer"</code> " credential. The server exposes exactly one tool: " <code>"generate_ui"</code> "."</p>
                <pre>"{\n  \"prompt\": \"A calm account settings screen\",\n  \"references\": [],\n  \"quality\": \"fast\",\n  \"aspect\": \"16:9\",\n  \"resolution\": \"1K\",\n  \"format\": \"png\",\n  \"background\": false\n}"</pre>
                <h2>"Agent discovery"</h2>
                <p>"The OpenAPI document and installable skill are public. Authentication is required only when the agent calls the generation tool."</p>
                <pre>"https://nibtool.com/openapi.json\nhttps://nibtool.com/.well-known/skills/generate/SKILL.md"</pre>
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
            <div class="eyebrow">"One review path"</div><h2>"Turn agent output into a clear human decision."</h2>
            <p class="section-copy">"Nib gives a coding agent a place to ask for review when tests are not enough. The request explains the change, carries the artifacts, and records what the human approved or sent back."</p>
            <div class="steps">
                <article class="step"><b>"01 / ASK"</b><h3>"Create the hosted request"</h3><p>"The agent packages the change, context, and acceptance question into one review request."</p></article>
                <article class="step"><b>"02 / REVIEW"</b><h3>"Invite the right humans"</h3><p>"Reviewers and guests can participate for free, so approval does not require seat accounting."</p></article>
                <article class="step"><b>"03 / RESOLVE"</b><h3>"Ship or send it back"</h3><p>"The decision stays attached to the work and gives the agent a precise next step."</p></article>
            </div>
        </div></section>
    }
}

#[component]
async fn agent_connection() -> Result {
    view! {
        <section class="section" id="agents"><div class="shell">
            <div class="eyebrow">"Free where collaboration should be free"</div>
            <h2>"Review participation is not the meter."</h2>
            <p class="section-copy">"Nib charges for hosted request volume and generation credit. The people and repositories involved in deciding whether the software is right stay outside the seat meter."</p>
            <div class="install-facts" aria-label="Installation results">
                <div><strong>"Free reviewing"</strong>"Humans can approve, reject, and comment without paid reviewer seats."</div>
                <div><strong>"Free guests and repos"</strong>"Invite external participants and connect repositories without expanding the bill."</div>
                <div><strong>"Free self-hosted use"</strong>"Run your own review flow without paying hosted request overage."</div>
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
            <div class="eyebrow">"Hosted request pricing"</div><h2>"Pay for hosted volume, not for people reviewing."</h2>
            <p class="section-copy">"Free includes 25 hosted requests and one Fast 1K trial. Paid plans add hosted request capacity and monthly generation credit; hosted overage is $0.05 per request where overage is available."</p>
            <div class="free-grid" aria-label="Always free Nib usage">
                <div><strong>"Reviewing is free"</strong>"Approvals, comments, and follow-up review decisions are not seat-billed."</div>
                <div><strong>"Guests and repos are free"</strong>"External participants and connected repositories do not change the plan price."</div>
                <div><strong>"Self-hosted stays free"</strong>"Use your own infrastructure when you do not need hosted request capacity."</div>
            </div>
            <div class="pricing-layout">
                <aside class="pricing-callout" aria-label="Free plan">
                    <div class="price-kicker">"Free"</div>
                    <div class="price-amount">"$0" <small>"/ month"</small></div>
                    <p>"25 hosted requests, one Fast 1K trial, and no overage. Start here when the team is proving the review loop."</p>
                    <p class="pricing-note">"Need configured checkout today? Starter uses the existing " <code>"default"</code> " plan and Pro uses the existing " <code>"high"</code> " plan."</p>
                    <div class="actions"><a class="button primary" href="/signup">"Start free"</a></div>
                </aside>
                <div class="pricing-table-wrap">
                    <table class="pricing-table">
                        <thead>
                            <tr><th>"Plan"</th><th>"Monthly"</th><th>"Hosted requests"</th><th>"Generation credit"</th><th>"Overage"</th><th>"Checkout"</th></tr>
                        </thead>
                        <tbody>
                            plan_row_checkout(name: "Starter", note: "Checkout configured as default", amount: "$9", requests: "100", credit: "$5", overage: "$0.05", href: "/signup?plan=default", label: "Choose Starter")
                            plan_row_checkout(name: "Pro", note: "Checkout configured as high", amount: "$24", requests: "500", credit: "$20", overage: "$0.05", href: "/signup?plan=high", label: "Choose Pro")
                            plan_row_pending(name: "Team", note: "Checkout not configured", amount: "$99", requests: "2,500", credit: "$50", overage: "$0.05")
                            plan_row_pending(name: "Scale", note: "Checkout not configured", amount: "$299", requests: "10,000", credit: "$150", overage: "$0.05")
                            plan_row_pending(name: "Enterprise", note: "BYOK or metered", amount: "Custom", requests: "25,000+", credit: "Custom", overage: "Metered")
                        </tbody>
                    </table>
                </div>
            </div>
            <p class="micro">"Team, Scale, and Enterprise are published for planning, but checkout is not configured on this site yet. Enterprise starts at 25,000 hosted requests and can use BYOK or metered generation."</p>
        </div></section>
    }
}

#[component]
async fn plan_row_checkout(
    name: &'static str,
    note: &'static str,
    amount: &'static str,
    requests: &'static str,
    credit: &'static str,
    overage: &'static str,
    href: &'static str,
    label: &'static str,
) -> Result {
    view! {
        <tr>
            <td data-label="Plan"><strong>(name)</strong><small>(note)</small></td>
            <td class="amount" data-label="Monthly">(amount)</td>
            <td data-label="Hosted requests">(requests)</td>
            <td data-label="Generation credit">(credit)</td>
            <td data-label="Overage">(overage)</td>
            <td class="checkout-cell" data-label="Checkout"><a class="button" href=(href)>(label)</a></td>
        </tr>
    }
}

#[component]
async fn plan_row_pending(
    name: &'static str,
    note: &'static str,
    amount: &'static str,
    requests: &'static str,
    credit: &'static str,
    overage: &'static str,
) -> Result {
    view! {
        <tr>
            <td data-label="Plan"><strong>(name)</strong><small>(note)</small></td>
            <td class="amount" data-label="Monthly">(amount)</td>
            <td data-label="Hosted requests">(requests)</td>
            <td data-label="Generation credit">(credit)</td>
            <td data-label="Overage">(overage)</td>
            <td class="checkout-cell" data-label="Checkout"><span class="checkout-pending">"Checkout not configured"</span></td>
        </tr>
    }
}

#[component]
async fn site_footer() -> Result {
    view! { <footer class="shell footer"><span>"Nib - human review for AI-generated software."</span><span><a href="https://github.com/douglance/nib">"Apache-2.0 source"</a> "  /  " <a href="/privacy">"Privacy"</a> "  /  " <a href="/terms">"Terms"</a></span></footer> }
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
        for path in [
            "/", "/docs", "/pricing", "/privacy", "/terms", "/account", "/signup",
        ] {
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

    #[tokio::test]
    async fn pricing_matches_the_approved_hosted_request_plans() {
        let response = router()
            .handle(
                Request::builder()
                    .uri("/pricing")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        let html = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let html = String::from_utf8(html.to_vec()).unwrap();

        assert!(html.contains("Pay for hosted volume, not for people reviewing."));
        assert!(html.contains("Free"));
        assert!(html.contains("25 hosted requests"));
        assert!(html.contains("Fast 1K trial"));
        assert!(html.contains("no overage"));
        assert!(html.contains("Starter"));
        assert!(html.contains("$9"));
        assert!(html.contains("Checkout configured as default"));
        assert!(html.contains("$5 generation credit"));
        assert!(html.contains("/signup?plan=default"));
        assert_eq!(html.matches("Choose Starter").count(), 1);
        assert!(html.contains("Pro"));
        assert!(html.contains("$24"));
        assert!(html.contains("Checkout configured as high"));
        assert!(html.contains("$20 generation credit"));
        assert!(html.contains("/signup?plan=high"));
        assert_eq!(html.matches("Choose Pro").count(), 1);
        assert!(html.contains("Team"));
        assert!(html.contains("$99"));
        assert!(html.contains("2,500"));
        assert!(html.contains("Scale"));
        assert!(html.contains("$299"));
        assert!(html.contains("10,000"));
        assert!(html.contains("Enterprise"));
        assert!(html.contains("25,000+"));
        assert!(html.contains("BYOK or metered"));
        assert!(html.contains("Checkout not configured"));
        assert!(html.contains("Reviewing is free"));
        assert!(html.contains("Guests and repos are free"));
        assert!(html.contains("Self-hosted stays free"));
        assert!(!html.contains("Configured checkout plans"));
        assert!(!html.contains("Configured checkout for hosted request volume."));
        assert!(!html.contains("Subscriptions have no included credits"));
    }
}
