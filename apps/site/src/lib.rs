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
:root{color-scheme:dark;--bg:#090b0f;--panel:#11151b;--panel-strong:#151b24;--line:#242b35;--muted:#9aa6b5;--text:#f6f8fb;--accent:#d8ff63;--accent-ink:#182000;--paper:#f6f4ef;--blue:#81a7ff;--focus:#f4ff9d}*{box-sizing:border-box}html{scroll-behavior:smooth}body{min-height:100vh;margin:0;display:flex;flex-direction:column;overflow-x:hidden;background:radial-gradient(circle at 72% 12%,#19263e 0,transparent 30%),var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.6}main{flex:1}img,video{max-width:100%}a{color:inherit;text-decoration:none}a:focus-visible,button:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--focus);outline-offset:3px}.shell{width:min(1120px,calc(100% - 40px));margin:auto}.nav{display:flex;align-items:center;gap:26px;min-height:76px;border-bottom:1px solid #ffffff12}.brand{margin-right:auto;font-weight:760;letter-spacing:-.035em;font-size:1.18rem}.brand-dot{color:var(--accent)}.nav-links{display:flex;align-items:center;gap:26px;color:var(--muted);font-size:.92rem}.nav-links a{padding:6px 0;border-bottom:1px solid transparent}.nav-links a:hover{color:var(--text)}.nav .button{flex:none}.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 19px;border:1px solid var(--line);border-radius:12px;font:680 .92rem/1.2 Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:-.01em;background:#141922;color:var(--text);cursor:pointer}.button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}.hero{display:grid;grid-template-columns:1.02fr .98fr;gap:72px;align-items:center;padding:96px 0 112px}.eyebrow{font:600 .75rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.13em;color:var(--accent)}h1{font-size:clamp(3.4rem,6.25vw,6rem);line-height:.98;letter-spacing:-.05em;margin:26px 0 32px;max-width:760px;text-wrap:balance}.lede{font-size:1.18rem;line-height:1.7;color:var(--muted);max-width:650px;text-wrap:pretty}.actions{display:flex;gap:12px;margin-top:38px;flex-wrap:wrap}.micro{margin-top:19px;color:#778394;font-size:.82rem;line-height:1.6}.viewport{position:relative;border:1px solid #364150;border-radius:22px;background:#0d1117;box-shadow:0 35px 100px #0009;overflow:hidden;aspect-ratio:4/3}.viewport img{display:block;width:100%;height:100%;object-fit:cover}.section{padding:100px 0;border-top:1px solid #ffffff12}.section h2{font-size:clamp(2.2rem,4vw,4rem);line-height:1.08;letter-spacing:-.045em;margin:17px 0 26px;text-wrap:balance}.section-copy{color:var(--muted);line-height:1.7;max-width:650px;text-wrap:pretty}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:48px}.step{border:1px solid var(--line);border-radius:18px;background:#10141a;padding:26px}.step b{font:600 .75rem/1.4 ui-monospace,monospace;color:var(--blue)}.step h3{margin:34px 0 10px;font-size:1.12rem;line-height:1.3}.step p,.price-card p{color:var(--muted);font-size:.9rem;line-height:1.65}.install-panel{max-width:900px;margin-top:42px;border:1px solid #465264;border-radius:20px;background:linear-gradient(145deg,#141a22,#0d1117);box-shadow:0 24px 70px #0006;overflow:hidden}.install-panel-head{display:flex;justify-content:space-between;gap:24px;padding:20px 22px;border-bottom:1px solid var(--line);color:var(--muted);font-size:.82rem}.install-panel-head strong{color:var(--text);font-weight:680}.install-prompt{margin:0;padding:26px 28px;white-space:pre-wrap;overflow-wrap:anywhere;color:#eef3fa;font:500 1rem/1.75 ui-monospace,SFMono-Regular,Menlo,monospace}.install-actions{display:flex;align-items:center;gap:12px;padding:0 22px 22px;flex-wrap:wrap}.install-status{min-height:1.4em;margin:0;color:var(--accent);font-size:.82rem}.install-facts,.free-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;max-width:900px;margin-top:28px;color:var(--muted);font-size:.86rem}.install-facts strong,.free-grid strong{display:block;margin-bottom:6px;color:var(--text);font-size:.95rem}.pricing-layout{display:grid;grid-template-columns:.55fr 1.45fr;gap:18px;align-items:start;margin-top:46px}.pricing-callout,.pricing-table-wrap,.price-card{border:1px solid var(--line);border-radius:18px;background:#10141a}.pricing-callout{padding:28px;background:linear-gradient(160deg,#151b24,#0f1319)}.pricing-callout .price-amount{font-size:3.5rem}.price-kicker{font:600 .75rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)}.price-amount{font-size:3rem;line-height:1.05;letter-spacing:-.04em;margin:14px 0}.price-amount small{font-size:.85rem;letter-spacing:0;color:var(--muted)}.pricing-note{margin:24px 0 0;color:#c8d0da;font-size:.9rem;line-height:1.7}.pricing-table-wrap{overflow:hidden}.pricing-table{width:100%;border-collapse:collapse;font-size:.9rem}.pricing-table th,.pricing-table td{padding:16px 18px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}.pricing-table th{color:var(--muted);font:600 .72rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.12em;background:#131821}.pricing-table tr:last-child td{border-bottom:0}.pricing-table strong{display:block;color:var(--text);font-size:1rem}.pricing-table small{display:block;color:var(--muted);line-height:1.5}.pricing-table .amount{font-weight:760;color:var(--text)}.pricing-table .button{white-space:nowrap}.checkout-cell{width:178px}.checkout-pending{display:inline-flex;align-items:center;min-height:36px;padding:0 12px;border:1px solid #39424f;border-radius:10px;color:#9aa6b5;background:#11151b;font-size:.78rem;font-weight:680}.configured-plans{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;margin-top:18px;max-width:820px}.price-card{padding:24px}.price-card.high{border-color:#a9cf42;box-shadow:inset 0 0 0 1px #a9cf4255}.price-card ul{padding:0;list-style:none;color:#c8d0da;font-size:.9rem;min-height:96px}.price-card li{margin:10px 0}.price-card li:before{content:"+";color:var(--accent);margin-right:9px}.price-card .button{width:100%}.footer{display:flex;justify-content:space-between;padding:36px 0 60px;color:#778394;font-size:.82rem}.legal,.docs{max-width:820px;padding:80px 0 120px}.legal h1,.docs h1{font-size:clamp(3rem,7vw,5.5rem)}.legal h2,.docs h2{margin-top:48px}.docs .install-panel{margin:42px 0 64px}.docs pre:not(.install-prompt){overflow:auto;padding:18px 20px;border:1px solid var(--line);border-radius:14px;background:#0d1117;color:#dce6f5;font:500 .88rem/1.7 ui-monospace,SFMono-Regular,Menlo,monospace}.docs code{color:var(--accent)}@media(max-width:980px){.pricing-layout{grid-template-columns:1fr}.checkout-cell{width:auto}}@media(max-width:820px){.nav{flex-wrap:wrap;min-height:0;padding:14px 0 0;column-gap:16px;row-gap:2px}.nav .button{order:2;min-height:40px;padding:0 15px}.nav-links{order:3;flex-wrap:wrap;width:100%;justify-content:flex-start;gap:6px 18px;padding:10px 0 4px;font-size:.85rem}.nav-links a{white-space:nowrap}.hero{grid-template-columns:1fr;gap:58px;padding:68px 0 104px}.steps,.install-facts,.free-grid,.configured-plans{grid-template-columns:1fr}.viewport{max-width:620px}h1{font-size:clamp(3.05rem,13vw,3.75rem);line-height:1;letter-spacing:-.045em}.section{padding:88px 0}.install-panel-head{display:block}.install-panel-head span{display:block;margin-top:5px}.install-prompt{padding:22px;font-size:.9rem}.pricing-table,.pricing-table tbody,.pricing-table tr,.pricing-table td{display:block}.pricing-table thead{display:none}.pricing-table tr{padding:16px 18px;border-bottom:1px solid var(--line)}.pricing-table tr:last-child{border-bottom:0}.pricing-table td{padding:5px 0;border:0}.pricing-table td:before{content:attr(data-label);display:block;margin-bottom:1px;color:var(--muted);font:600 .67rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.12em}.footer{gap:20px;flex-direction:column}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
"#;

const SIGNUP_CSS: &str = r#"
.signup{max-width:900px;padding:80px 0 120px}.signup h1{font-size:clamp(3rem,7vw,5.5rem)}.credential-panel{margin-top:42px;padding:30px;border:1px solid var(--line);border-radius:20px;background:linear-gradient(145deg,#141a22,#0d1117)}.credential-panel[hidden]{display:none}.credential-panel h2{margin:0 0 12px;font-size:1.4rem}.token-value{display:block;margin:22px 0;padding:18px 20px;overflow-wrap:anywhere;border:1px solid #a9cf4266;border-radius:14px;background:#090b0f;color:var(--accent);font:600 .9rem/1.65 ui-monospace,SFMono-Regular,Menlo,monospace}.credential-actions{display:flex;gap:12px;flex-wrap:wrap}.credential-plans{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:30px}.credential-plans form,.credential-plans button{width:100%}.credential-note{color:var(--muted);font-size:.88rem}.credential-status{min-height:1.4em;color:var(--accent);font-size:.85rem}.signup .button{margin-top:8px}@media(max-width:680px){.credential-panel{padding:22px}.credential-plans{grid-template-columns:1fr}.token-value{font-size:.78rem}}
"#;

const HOME_CSS: &str = r#"
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.story-hero{display:grid;grid-template-columns:minmax(0,1.06fr) minmax(0,.94fr);gap:72px;align-items:center;padding:88px 0 96px}.story-hero h1{font-size:clamp(3.2rem,5.6vw,5.4rem);margin:20px 0 22px}.hero-sub{max-width:520px;margin:0;color:#c5ced9;font-size:1.12rem;line-height:1.6}.hero-sub strong{color:var(--text)}.story-hero .actions{gap:24px;align-items:center;margin-top:34px}.story-hero .button.primary{min-height:52px;padding:0 26px;font-size:1rem}.jump-link{display:inline-flex;align-items:center;gap:9px;color:#c5ced9;font-size:.92rem;font-weight:620;border-bottom:1px solid #ffffff2e;padding-bottom:2px}.jump-link svg{width:15px;height:15px;fill:currentColor}.hero-facts{display:flex;flex-wrap:wrap;gap:14px;margin:34px 0 0;padding:0}.hero-facts div{display:flex;align-items:baseline;gap:8px;padding:9px 14px;border:1px solid var(--line);border-radius:999px;background:#10141a}.hero-facts dt{color:var(--accent);font-size:.92rem;font-weight:760;letter-spacing:-.02em}.hero-facts dd{margin:0;color:var(--muted);font-size:.8rem}
.capture{display:flex;flex-direction:column;margin:0;border:1px solid var(--line);border-radius:20px;overflow:hidden;background:var(--paper);box-shadow:0 30px 90px #000a}.capture picture{order:2;display:contents}.capture img{order:2;display:block;width:100%;height:auto}.capture-tag{order:1;display:flex;align-items:center;gap:9px;padding:12px 17px;border-bottom:1px solid var(--line);background:#10141a;color:#cbd3dc;font:650 .68rem/1 ui-monospace,monospace;letter-spacing:.09em}.capture-tag i{flex:none;width:7px;height:7px;border-radius:50%;background:var(--accent)}
.hero-shot{justify-self:center;width:min(100%,360px);margin:0}.hero-device{position:relative;padding:13px;border:1px solid #333d4b;border-radius:34px;background:linear-gradient(160deg,#232b36,#12161d)}.hero-device .capture{border:0;border-radius:22px;box-shadow:0 26px 70px #000c}.hero-shot figcaption{display:flex;align-items:center;justify-content:center;gap:9px;margin-top:16px;color:var(--muted);font:650 .68rem/1 ui-monospace,monospace;letter-spacing:.09em}.hero-shot figcaption i{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.loop-shell{padding:74px 0;border-top:1px solid #ffffff12}.loop-head{display:flex;align-items:baseline;justify-content:space-between;gap:32px;margin-bottom:30px}.loop-head h2{margin:0;font-size:1.14rem;font-weight:700;letter-spacing:-.02em}.loop-head p{margin:0;color:var(--muted);font-size:.88rem}.flow-strip{display:grid;grid-template-columns:1fr auto 1fr auto 1fr auto 1fr auto 1fr;gap:10px;align-items:start;padding:26px 20px;border:1px solid var(--line);border-radius:24px;background:#0d1117}.flow-node{min-width:0;text-align:center}.flow-icon{display:grid;place-items:center;width:60px;height:60px;margin:0 auto 14px;border:1px solid #34404e;border-radius:18px;background:#171d25;color:#dce5ef}.flow-node.request .flow-icon,.flow-node.decision .flow-icon{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}.flow-icon svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.flow-node strong{display:block;font-size:.86rem}.flow-node small{display:block;margin-top:2px;color:var(--muted);font-size:.72rem}.flow-arrow{padding-top:20px;color:#5c6675}.flow-arrow svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.visual-section{padding:88px 0;border-top:1px solid #ffffff12}.visual-head{display:flex;align-items:end;justify-content:space-between;gap:40px;margin-bottom:34px}.visual-head h2{max-width:640px;margin:12px 0 0;font-size:clamp(2.1rem,3.6vw,3.2rem);line-height:1.06;letter-spacing:-.045em}.visual-note{max-width:290px;margin:0;color:var(--muted);font-size:.88rem}
.proof-stack{display:grid;gap:18px}.proof-main img{max-height:600px;object-fit:cover;object-position:top}.proof-legend{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:18px;margin-top:26px}.proof-legend p{max-width:420px;margin:0;color:var(--muted);font-size:.9rem;line-height:1.6}
.marks{display:flex;flex-wrap:wrap;gap:10px;padding:0;list-style:none}.marks li{display:inline-flex;align-items:center;gap:9px;padding:9px 13px;border:1px solid var(--line);border-radius:999px;background:#10141a;color:#cbd3dc;font-size:.82rem}.marks svg{width:16px;height:16px;fill:none;stroke:var(--accent);stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.film-frame{position:relative;margin:0;border:1px solid #394553;border-radius:24px;overflow:hidden;background:#0d1117;box-shadow:0 28px 80px #0008}.product-film{display:block;width:100%;aspect-ratio:13/9;background:#0d1117}.film-key{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line);background:#11151b}.film-key div{display:flex;align-items:center;gap:11px;padding:16px 20px;border-right:1px solid var(--line);color:#cbd3dc;font-size:.85rem}.film-key div:last-child{border:0}.film-key b{display:grid;place-items:center;flex:none;width:24px;height:24px;border-radius:50%;background:#202833;color:var(--accent);font:700 .7rem/1 ui-monospace,monospace}
.resume-grid{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:20px;align-items:start}.payload{margin:0;padding:22px 24px;overflow-x:auto;border:1px solid var(--line);border-radius:20px;background:#0d1117;color:#dce6f5;font:500 .82rem/1.75 ui-monospace,SFMono-Regular,Menlo,monospace}.payload b{color:var(--accent);font-weight:500}.payload-head{display:flex;align-items:center;gap:9px;margin-bottom:14px;color:var(--muted);font:650 .7rem/1 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase}.payload-head i{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.home-pricing{padding:88px 0 96px;border-top:1px solid #ffffff12}.pricing-compact{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:34px}.mini-plan{display:flex;flex-direction:column;padding:26px;border:1px solid var(--line);border-radius:22px;background:#10141a}.mini-plan.featured{border-color:#a9cf42;background:linear-gradient(165deg,#171d16,#10141a 58%)}.mini-plan h3{display:flex;align-items:center;gap:10px;margin:0;font-size:.95rem}.mini-plan .flag{padding:4px 8px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font:700 .62rem/1.3 ui-monospace,monospace;letter-spacing:.06em}.mini-price{margin:22px 0 4px;font-size:2.6rem;line-height:1;letter-spacing:-.05em;font-weight:780}.mini-price small{font-size:.7rem;color:var(--muted);letter-spacing:0;font-weight:600}.mini-plan p{margin:0;color:#c8d0da;font-size:.86rem}.mini-plan .unit{margin-top:6px;color:var(--muted);font-size:.78rem}.mini-plan .button{width:100%;margin-top:22px}.pricing-foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:16px;margin-top:22px;color:var(--muted);font-size:.85rem}.pricing-foot a{border-bottom:1px solid #ffffff2e;color:#c5ced9}
@media(max-width:980px){.story-hero{grid-template-columns:1fr;gap:48px;padding:64px 0 76px}.hero-shot{justify-self:start}.resume-grid{grid-template-columns:1fr}.proof-main img{max-height:460px}}
@media(max-width:720px){.story-hero{padding-top:48px}.story-hero h1{font-size:clamp(2.7rem,11vw,3.6rem)}.story-hero .actions{gap:18px}.story-hero .button.primary{width:100%}.hero-shot{width:100%}.hero-device{padding:10px;border-radius:26px}.loop-shell,.visual-section,.home-pricing{padding:64px 0}.loop-head{display:block}.loop-head p{margin-top:8px}.flow-strip{grid-template-columns:1fr;gap:4px;padding:18px}.flow-node{display:grid;grid-template-columns:46px 1fr;column-gap:14px;align-items:center;text-align:left;width:min(100%,250px);margin:auto}.flow-icon{grid-row:1/3;width:46px;height:46px;margin:0;border-radius:14px}.flow-icon svg{width:22px;height:22px}.flow-arrow{padding:0;transform:rotate(90deg);text-align:center}.visual-head{display:block}.visual-note{margin-top:14px}.film-frame{border-radius:18px}.film-key{grid-template-columns:1fr}.film-key div{border-right:0;border-bottom:1px solid var(--line);padding:13px 16px}.film-key div:last-child{border:0}.pricing-compact{grid-template-columns:1fr}.payload{font-size:.76rem}}
@media(prefers-reduced-motion:reduce){.product-film{animation:none}}
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
      "description": "The fastest way for humans to review images produced by AI software."
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://nibtool.com/#software",
      "name": "Nib",
      "url": "https://nibtool.com/",
      "applicationCategory": "DeveloperApplication",
      "operatingSystem": "Any",
      "description": "Send an image for human review and return a structured decision to the agent. Tests verify behavior. Nib verifies intent.",
      "featureList": [
        "Review images from agents and developer tools",
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
          "description": "100 hosted requests, $5 optional UI generation credit, then $0.05 per extra hosted request"
        },
        {
          "@type": "Offer",
          "name": "Pro",
          "price": "24",
          "priceCurrency": "USD",
          "description": "500 hosted requests, $20 optional UI generation credit, then $0.05 per extra hosted request"
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
    for asset in [
        "nib-review-desktop.png",
        "nib-review-decision.png",
        "nib-review-sent.png",
        "nib-review-mobile-evidence.png",
        "nib-review-mobile-decision.png",
        "nib-product-tour.mp4",
        "nib-product-tour-poster.png",
    ] {
        tokio::fs::copy(source.join(asset), assets.join(asset)).await?;
    }
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
            description: "Your agent made an image. Nib gets the human decision and returns it to the agent.",
            canonical: "https://nibtool.com/",
            <main>
                hero_story()
                how_it_works()
                agent_connection()
                home_pricing()
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
                    <a class="button primary" href="https://app.nibtool.com/account">"Open billing portal"</a>
                    <a class="button" href="/docs">"Read the quick start"</a>
                    <a class="button" href="https://app.nibtool.com/account">"Open account portal"</a>
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
            description: "Create a free Nib account and start reviewing AI-generated software from any device.",
            canonical: "https://nibtool.com/signup",
            <main class="shell signup">
                <section data-signup-panel="">
                    <div class="eyebrow">"Free hosted reviews"</div>
                    <h1>"Your Nib account, everywhere."</h1>
                    <p class="lede">"Sign in by email or passkey. Your personal workspace follows you across browsers, computers, and locations."</p>
                    <a class="button primary" href="https://app.nibtool.com/signin">"Create free account"</a>
                    <p class="micro">"Review links still work without an account. Creators sign in when they need to send or automate requests."</p>
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
                <h2 id="authentication">"Sign in once"</h2>
                <p>"Run the login command. Nib opens the account portal, asks you to approve this device, and stores the resulting credential in your system Keychain."</p>
                <pre>"nib auth login"</pre>
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
                <style>(HOME_CSS)</style>
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
                <a href="/#how">"How it works"</a>
                <a href="/#reviewer">"The reviewer"</a>
                <a href="/pricing">"Pricing"</a>
                <a href="/docs">"Docs"</a>
            </nav>
            <a class="button primary" href="https://app.nibtool.com/signin">"Start free"</a>
        </header>
    }
}

#[component]
async fn hero_story() -> Result {
    view! {
        <section class="shell story-hero">
            <div>
                <div class="eyebrow">"Image review for AI software"</div>
                <h1>"Your agent did the work. You make the call."</h1>
                <p class="hero-sub">"Your agent sends the image in one link. You " <strong>"approve, reject, or mark what needs to change"</strong> "—then the agent resumes."</p>
                <div class="actions">
                    <a class="button primary" href="https://app.nibtool.com/signin">"Start free"</a>
                    <a class="jump-link" href="#tour">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>
                        "See the 11-second loop"
                    </a>
                </div>
                <dl class="hero-facts">
                    <div><dt>"$0"</dt><dd>"to review"</dd></div>
                    <div><dt>"25"</dt><dd>"free requests a month"</dd></div>
                    <div><dt>"No account"</dt><dd>"for reviewers"</dd></div>
                </dl>
            </div>
            <figure class="hero-shot">
                <div class="hero-device">
                    <div class="capture">
                        <img src="/assets/nib-review-mobile-evidence.png" width="1170" height="1437" alt="The Nib reviewer on a phone showing the pricing-page image an agent submitted for human review." fetchpriority="high">
                    </div>
                </div>
                <figcaption><i></i>"THE IMAGE UNDER REVIEW"</figcaption>
            </figure>
        </section>
    }
}

#[component]
async fn how_it_works() -> Result {
    view! {
        <section class="shell loop-shell" id="how">
            <div class="loop-head">
                <h2>"How it works"</h2>
                <p>"Five steps. Nothing to install for the person reviewing."</p>
            </div>
            <div class="flow-strip" role="img" aria-label="Agent creates a Nib Request, you review it, the decision returns, and the agent resumes.">
                <div class="flow-node"><div class="flow-icon"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="m7 9 3 3-3 3M13 15h4"></path></svg></div><strong>"Agent"</strong><small>"creates work"</small></div>
                <div class="flow-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"></path></svg></div>
                <div class="flow-node request"><div class="flow-icon"><svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"></path><path d="M14 3v6h6M8 14h8M8 17h5"></path></svg></div><strong>"Nib Request"</strong><small>"carries evidence"</small></div>
                <div class="flow-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"></path></svg></div>
                <div class="flow-node"><div class="flow-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path></svg></div><strong>"You"</strong><small>"review"</small></div>
                <div class="flow-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"></path></svg></div>
                <div class="flow-node decision"><div class="flow-icon"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="m8 12 3 3 5-6"></path></svg></div><strong>"Decision"</strong><small>"structured"</small></div>
                <div class="flow-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"></path></svg></div>
                <div class="flow-node"><div class="flow-icon"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 1-2.3-5.7L20 8"></path><path d="M20 3v5h-5"></path></svg></div><strong>"Agent"</strong><small>"resumes"</small></div>
            </div>
        </section>
    }
}

#[component]
async fn agent_connection() -> Result {
    view! {
        <section class="visual-section" id="reviewer"><div class="shell">
            <div class="visual-head">
                <div><div class="eyebrow">"The reviewer"</div><h2>"Every artifact, one page, four answers."</h2></div>
                <p class="visual-note">"Unretouched captures of the Nib review page."</p>
            </div>
            <div class="proof-stack">
                <figure class="capture proof-main">
                    <picture>
                        <source media="(max-width: 720px)" srcset="/assets/nib-review-mobile-evidence.png">
                        <img src="/assets/nib-review-desktop.png" alt="The Nib review page showing a request title, description, and the screenshot the agent attached as evidence." loading="lazy">
                    </picture>
                    <figcaption class="capture-tag"><i></i>"EVIDENCE THE AGENT ATTACHED"</figcaption>
                </figure>
                <figure class="capture proof-band">
                    <picture>
                        <source media="(max-width: 720px)" srcset="/assets/nib-review-mobile-decision.png">
                        <img src="/assets/nib-review-decision.png" alt="The Nib review page decision row: a reviewer note and Comment, Approve, Reject, and Request changes buttons." loading="lazy">
                    </picture>
                    <figcaption class="capture-tag"><i></i>"THE FOUR ANSWERS"</figcaption>
                </figure>
            </div>
            <div class="proof-legend">
                <p>"Whatever the agent attached renders in place, so the person deciding never has to go find it."</p>
                <ul class="marks">
                    <li><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m3 15 5-4 4 3 3-2 6 5"></path></svg>"Image"</li>
                    <li><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m11 9 4 3-4 3z"></path></svg>"Video"</li>
                    <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"></path><path d="M9 13h6M12 10v6"></path></svg>"Diff"</li>
                    <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"></path><path d="M9 12h6M9 16h4"></path></svg>"File"</li>
                    <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"></path><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"></path></svg>"URL"</li>
                </ul>
            </div>
        </div></section>
        <section class="visual-section" id="tour"><div class="shell">
            <div class="visual-head">
                <div><div class="eyebrow">"11 seconds, start to finish"</div><h2>"Ask. Review. Decide. Continue."</h2></div>
                <p class="visual-note">"Screen recording of a real review, at real speed."</p>
            </div>
            <figure class="film-frame">
                <video class="product-film" controls="controls" preload="metadata" playsinline="playsinline" poster="/assets/nib-product-tour-poster.png" aria-label="A Nib review moving from attached evidence to a sent human decision">
                    <source src="/assets/nib-product-tour.mp4" type="video/mp4">
                    "Your browser does not support video. The flow is agent, Nib Request, human decision, and agent continuation."
                </video>
                <figcaption class="film-key"><div><b>"1"</b>"Agent sends request"</div><div><b>"2"</b>"Human reviews evidence"</div><div><b>"3"</b>"Decision returns as data"</div></figcaption>
            </figure>
        </div></section>
        <section class="visual-section" id="resume"><div class="shell">
            <div class="visual-head">
                <div><div class="eyebrow">"The agent resumes"</div><h2>"Your call comes back as data."</h2></div>
                <p class="visual-note">"The waiting agent gets a structured decision, not a screenshot of a chat."</p>
            </div>
            <div class="resume-grid">
                <figure class="capture">
                    <img src="/assets/nib-review-sent.png" alt="The same Nib review page after approval, with the status pill reading Sent." loading="lazy">
                    <figcaption class="capture-tag"><i></i>"SENT"</figcaption>
                </figure>
                <pre class="payload"><div class="payload-head"><i></i>"What the agent receives"</div>"{\n  \"outcome\": " <b>"\"approved\""</b> ",\n  \"requestId\": \"req_checkout_review\",\n  \"requestRevision\": 1,\n  \"reviewer\": { \"type\": \"guest\" },\n  \"createdAt\": \"2026-08-09T15:04:11Z\"\n}"</pre>
            </div>
        </div></section>
    }
}

#[component]
async fn home_pricing() -> Result {
    view! {
        <section class="home-pricing" id="pricing"><div class="shell">
            <div class="visual-head">
                <div><div class="eyebrow">"Pricing"</div><h2>"Reviewing is free. You pay to send."</h2></div>
                <p class="visual-note">"Metered per hosted request. No seats, no per-reviewer fee, no card to start."</p>
            </div>
            <div class="pricing-compact">
                <article class="mini-plan">
                    <h3>"Free"</h3>
                    <div class="mini-price">"$0"</div>
                    <p>"25 hosted requests a month"</p>
                    <div class="unit">"No card. No overage."</div>
                    <a class="button" href="https://app.nibtool.com/signin">"Start free"</a>
                </article>
                <article class="mini-plan">
                    <h3>"Starter"</h3>
                    <div class="mini-price">"$9" <small>"/ month"</small></div>
                    <p>"100 hosted requests + $5 for optional AI-generated UI previews"</p>
                    <div class="unit">"Then $0.05 per extra hosted request"</div>
                    <a class="button" href="https://app.nibtool.com/signin?callbackURL=%2Faccount">"Choose Starter"</a>
                </article>
                <article class="mini-plan featured">
                    <h3>"Pro" <span class="flag">"BEST VALUE"</span></h3>
                    <div class="mini-price">"$24" <small>"/ month"</small></div>
                    <p>"500 hosted requests + $20 for optional AI-generated UI previews"</p>
                    <div class="unit">"Then $0.05 per extra hosted request"</div>
                    <a class="button primary" href="https://app.nibtool.com/signin?callbackURL=%2Faccount">"Choose Pro"</a>
                </article>
            </div>
            <div class="pricing-foot">
                <span>"Guests, repositories, and self-hosted use stay free on every plan."</span>
                <a href="/pricing">"Team, Scale, and Enterprise"</a>
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
            <p class="section-copy">"One price per hosted request. Overage is $0.05 per extra request where available. Generation credit applies only to optional AI-generated UI previews."</p>
            <div class="free-grid" aria-label="Always free Nib usage">
                <div><strong>"Reviewing is free"</strong>"Approvals, comments, and follow-up decisions are never seat-billed."</div>
                <div><strong>"Guests and repos are free"</strong>"External participants and connected repositories do not change the price."</div>
                <div><strong>"Self-hosted stays free"</strong>"Run the open-source reviewer on your own infrastructure."</div>
            </div>
            <div class="pricing-layout">
                <aside class="pricing-callout" aria-label="Free plan">
                    <div class="price-kicker">"Free"</div>
                    <div class="price-amount">"$0" <small>"/ month"</small></div>
                    <p>"25 hosted requests, one Fast 1K trial, no card, and no overage."</p>
                    <div class="actions"><a class="button primary" href="https://app.nibtool.com/signin">"Start free"</a></div>
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
            <p class="micro">"Team, Scale, and Enterprise are published for planning; checkout for them is not configured yet. Enterprise starts at 25,000 hosted requests with BYOK or metered generation."</p>
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
    view! { <footer class="shell footer"><span>"Nib - human review for AI-generated software."</span><span><a href="https://app.nibtool.com/account">"Account"</a> "  /  " <a href="https://github.com/douglance/nib">"Apache-2.0 source"</a> "  /  " <a href="/privacy">"Privacy"</a> "  /  " <a href="/terms">"Terms"</a></span></footer> }
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
    async fn homepage_explains_the_review_loop_with_visual_media() {
        let response = router()
            .handle(Request::builder().uri("/").body(Body::empty()).unwrap())
            .await;
        let html = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let html = String::from_utf8(html.to_vec()).unwrap();

        assert!(html.contains("Your agent did the work. You make the call."));
        for asset in [
            "/assets/nib-review-desktop.png",
            "/assets/nib-review-decision.png",
            "/assets/nib-review-sent.png",
            "/assets/nib-review-mobile-evidence.png",
            "/assets/nib-review-mobile-decision.png",
            "/assets/nib-product-tour.mp4",
            "/assets/nib-product-tour-poster.png",
        ] {
            assert!(html.contains(asset), "{asset}");
        }
        assert!(html.contains("Agent creates a Nib Request"));
        assert!(html.contains("Every artifact, one page, four answers."));
        assert!(html.contains("Your call comes back as data."));
        assert_eq!(html.matches("<video").count(), 1);
        // The persistent and hero actions stay primary, while pricing emphasizes Pro.
        assert_eq!(html.matches("class=\"button primary\"").count(), 3);
        assert_eq!(html.matches("Start free").count(), 3);
        assert!(html.contains(
            "class=\"button primary\" href=\"https://app.nibtool.com/signin?callbackURL=%2Faccount\">Choose Pro"
        ));
        assert!(!html.contains("href=\"/signup"));
        assert!(html.contains("Agent sends request"));
        assert!(html.contains("Decision returns as data"));
        assert!(html.contains("req_checkout_review"));
        assert!(!html.contains("Turn agent output into a clear human decision."));
        assert!(!html.contains("Checkout not configured"));
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
        assert!(html.contains("$5 optional UI generation credit"));
        assert!(html.contains("/signup?plan=default"));
        assert_eq!(html.matches("Choose Starter").count(), 1);
        assert!(html.contains("Pro"));
        assert!(html.contains("$24"));
        assert!(html.contains("Checkout configured as high"));
        assert!(html.contains("$20 optional UI generation credit"));
        assert!(
            html.contains("Generation credit applies only to optional AI-generated UI previews.")
        );
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
