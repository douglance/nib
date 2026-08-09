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

const HOME_CSS: &str = r#"
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.story-hero{display:grid;grid-template-columns:minmax(0,.88fr) minmax(520px,1.12fr);gap:64px;align-items:center;padding:82px 0 44px}.story-hero h1{font-size:clamp(3.5rem,6.2vw,6rem);margin:20px 0 24px}.hero-sub{max-width:570px;margin:0;color:#c5ced9;font-size:1.16rem;line-height:1.65}.hero-sub strong{color:var(--text)}.story-hero .actions{margin-top:30px}.button.play-link{gap:9px;background:transparent}.button.play-link svg{width:18px;height:18px;fill:currentColor}.hero-facts{display:flex;gap:26px;margin:32px 0 0;padding:24px 0 0;border-top:1px solid var(--line)}.hero-facts div{min-width:92px}.hero-facts dt{color:var(--accent);font-size:1.28rem;font-weight:780;letter-spacing:-.03em}.hero-facts dd{margin:2px 0 0;color:var(--muted);font-size:.78rem}.hero-art{position:relative;margin:0;border:1px solid #394553;border-radius:28px;overflow:hidden;background:#0d1117;box-shadow:0 38px 100px #000a;aspect-ratio:16/10}.hero-art img{display:block;width:100%;height:100%;object-fit:cover}.hero-media-tags{position:absolute;left:22px;bottom:20px;display:flex;gap:8px}.hero-media-tags span{display:inline-flex;align-items:center;gap:7px;padding:8px 11px;border:1px solid #ffffff24;border-radius:999px;background:#090b0fdd;backdrop-filter:blur(10px);color:#eef3fa;font:650 .72rem/1 ui-monospace,monospace}.hero-media-tags i{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.loop-shell{padding:32px 0 88px}.flow-strip{display:grid;grid-template-columns:1fr auto 1fr auto 1fr auto 1fr auto 1fr;gap:12px;align-items:center;padding:20px;border:1px solid var(--line);border-radius:24px;background:#0d1117}.flow-node{min-width:0;text-align:center}.flow-icon{display:grid;place-items:center;width:64px;height:64px;margin:0 auto 12px;border:1px solid #34404e;border-radius:18px;background:#171d25;color:#dce5ef}.flow-node.request .flow-icon,.flow-node.decision .flow-icon{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}.flow-icon svg{width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.flow-node strong{display:block;font-size:.86rem}.flow-node small{display:block;margin-top:2px;color:var(--muted);font-size:.7rem}.flow-arrow{color:#657080}.flow-arrow svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.visual-section{padding:96px 0;border-top:1px solid #ffffff12}.visual-head{display:flex;align-items:end;justify-content:space-between;gap:40px;margin-bottom:38px}.visual-head h2{max-width:760px;margin:12px 0 0;font-size:clamp(2.5rem,5vw,4.6rem);line-height:1.02;letter-spacing:-.05em}.visual-note{max-width:300px;margin:0;color:var(--muted);font-size:.9rem}.film-frame{position:relative;margin:0;border:1px solid #394553;border-radius:28px;overflow:hidden;background:#0d1117;box-shadow:0 28px 80px #0008}.product-film{display:block;width:100%;aspect-ratio:16/10;background:#0d1117}.film-key{display:grid;grid-template-columns:repeat(3,1fr);border-top:1px solid var(--line);background:#11151b}.film-key div{display:flex;align-items:center;gap:11px;padding:18px 22px;border-right:1px solid var(--line);color:#cbd3dc;font-size:.86rem}.film-key div:last-child{border:0}.film-key b{display:grid;place-items:center;width:25px;height:25px;border-radius:50%;background:#202833;color:var(--accent);font:700 .72rem/1 ui-monospace,monospace}
.review-showcase{display:grid;grid-template-columns:minmax(300px,.64fr) minmax(0,1.36fr);gap:22px;align-items:stretch}.phone-card,.artifact-board{border:1px solid var(--line);border-radius:28px;background:#10141a;overflow:hidden}.phone-card{position:relative;display:grid;place-items:center;min-height:600px;padding:34px;background:radial-gradient(circle at 50% 20%,#233044,#10141a 62%)}.phone-card img{display:block;width:min(100%,350px);height:auto;border-radius:28px;box-shadow:0 28px 70px #000a}.phone-card figcaption{position:absolute;left:22px;bottom:20px;padding:8px 12px;border:1px solid #ffffff20;border-radius:999px;background:#090b0fdd;color:#dce5ef;font-size:.74rem}.artifact-board{padding:28px}.board-top{display:flex;align-items:center;justify-content:space-between;padding-bottom:22px;border-bottom:1px solid var(--line)}.board-brand{font-size:1.1rem;font-weight:760}.board-brand span{color:var(--accent)}.board-status{display:inline-flex;align-items:center;gap:8px;color:#cbd3dc;font-size:.76rem}.board-status i{width:8px;height:8px;border-radius:50%;background:#7bd88f}.artifact-grid{display:grid;grid-template-columns:1.2fr .8fr;grid-template-rows:1fr 1fr;gap:14px;margin-top:22px;min-height:342px}.artifact-tile{position:relative;overflow:hidden;border:1px solid #303a48;border-radius:20px;background:#181f29}.artifact-tile.image{grid-row:1/3;background:linear-gradient(145deg,#26303c,#12171e)}.artifact-tile.image .mock-screen{position:absolute;inset:34px;border-radius:15px;background:#edf0f3}.mock-screen:before{content:"";position:absolute;left:28px;top:34px;width:42%;height:14px;border-radius:8px;background:#aeb8c2;box-shadow:0 34px 0 #c3cad2,0 68px 0 #c3cad2}.mock-screen:after{content:"";position:absolute;left:28px;bottom:32px;width:35%;height:34px;border-radius:10px;background:#151b24}.annotation-pin{position:absolute;right:20%;top:42%;display:grid;place-items:center;width:40px;height:40px;border:3px solid #182000;border-radius:50%;background:var(--accent);color:var(--accent-ink);font-weight:800}.artifact-tile.video{display:grid;place-items:center;background:linear-gradient(145deg,#1d2630,#11161d)}.play-mark{display:grid;place-items:center;width:70px;height:70px;border-radius:50%;background:var(--accent);color:var(--accent-ink)}.play-mark svg{width:27px;height:27px;fill:currentColor}.artifact-tile.diff{padding:32px 24px}.diff-line{height:9px;margin:12px 0;border-radius:8px;background:#7bd88f}.diff-line.remove{width:62%;background:#ff837a}.diff-line.short{width:74%}.tile-label{position:absolute;left:14px;bottom:12px;padding:6px 9px;border-radius:8px;background:#090b0fcc;color:#e9eef4;font:650 .7rem/1 ui-monospace,monospace}.feedback-bubble{display:flex;gap:13px;margin-top:14px;padding:17px 18px;border:1px solid #a9cf4245;border-radius:18px;background:#171d25}.feedback-pin{display:grid;place-items:center;flex:0 0 30px;height:30px;border-radius:50%;background:var(--accent);color:var(--accent-ink);font-weight:800}.feedback-bubble strong{display:block;font-size:.9rem}.feedback-bubble span{display:block;margin-top:3px;color:var(--muted);font-size:.78rem}
.home-pricing{padding:96px 0;border-top:1px solid #ffffff12}.pricing-compact{display:grid;grid-template-columns:1fr repeat(3,.58fr);gap:14px;align-items:stretch;margin-top:36px}.pricing-intro{display:flex;flex-direction:column;justify-content:space-between;padding:28px;border:1px solid #3c4755;border-radius:22px;background:linear-gradient(145deg,#151b24,#0d1117)}.pricing-intro h2{margin:10px 0 18px;font-size:clamp(2.3rem,4vw,3.8rem);line-height:1.04;letter-spacing:-.05em}.pricing-intro p{margin:0;color:var(--muted);font-size:.88rem}.pricing-intro .button{align-self:flex-start;margin-top:28px}.mini-plan{padding:24px;border:1px solid var(--line);border-radius:22px;background:#10141a}.mini-plan.featured{border-color:#a9cf42;box-shadow:inset 0 0 0 1px #a9cf4244}.mini-plan h3{margin:0;font-size:.92rem}.mini-price{margin:28px 0 6px;font-size:2.7rem;line-height:1;letter-spacing:-.05em;font-weight:780}.mini-price small{font-size:.72rem;color:var(--muted);letter-spacing:0}.mini-plan p{margin:0;color:var(--muted);font-size:.8rem}.mini-plan .plan-dot{display:block;width:10px;height:10px;margin-top:34px;border-radius:50%;background:#3c4652}.mini-plan.featured .plan-dot{background:var(--accent)}
@media(max-width:980px){.story-hero{grid-template-columns:1fr;gap:44px}.hero-art{max-width:760px}.pricing-compact{grid-template-columns:repeat(3,1fr)}.pricing-intro{grid-column:1/-1}.review-showcase{grid-template-columns:1fr}.phone-card{min-height:auto}.phone-card img{width:min(100%,320px)}}
@media(max-width:720px){.story-hero{padding-top:56px}.story-hero h1{font-size:clamp(3.1rem,14vw,4.2rem)}.hero-facts{gap:18px}.hero-art{border-radius:20px}.hero-media-tags{left:12px;bottom:12px}.hero-media-tags span{padding:7px 9px}.loop-shell{padding-bottom:70px}.flow-strip{grid-template-columns:1fr;gap:6px}.flow-node{display:grid;grid-template-columns:48px 1fr;column-gap:12px;align-items:center;text-align:left;width:min(100%,260px);margin:auto}.flow-icon{grid-row:1/3;width:48px;height:48px;margin:0;border-radius:14px}.flow-icon svg{width:24px;height:24px}.flow-arrow{transform:rotate(90deg);text-align:center}.visual-section,.home-pricing{padding:76px 0}.visual-head{display:block}.visual-note{margin-top:16px}.film-frame{border-radius:20px}.film-key{grid-template-columns:1fr}.film-key div{border-right:0;border-bottom:1px solid var(--line);padding:14px 18px}.film-key div:last-child{border:0}.artifact-board{padding:18px}.artifact-grid{grid-template-columns:1fr;grid-template-rows:270px 170px 170px}.artifact-tile.image{grid-row:auto}.pricing-compact{grid-template-columns:1fr}.pricing-intro{grid-column:auto}.phone-card{padding:22px}.phone-card figcaption{position:static;margin-top:18px}.hero-facts dd{font-size:.7rem}}
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
    for asset in [
        "generated-ui-hero.png",
        "nib-decision-loop-hero.png",
        "nib-mobile-review.png",
        "nib-product-tour.mp4",
        "tour-01.png",
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
            description: "Your agent did the work. Nib packages the evidence, gets a human decision, and returns it to the agent.",
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
                <a href="/#pricing">"Pricing"</a>
                <a href="/account">"Account"</a>
                <a class="button" href="/signup">"Start free"</a>
            </nav>
        </header>
    }
}

#[component]
async fn hero_story() -> Result {
    view! {
        <section class="shell story-hero">
            <div>
                <div class="eyebrow">"Human review for AI software"</div>
                <h1>"Your agent did the work. You make the call."</h1>
                <p class="hero-sub">"Nib turns " <strong>"code, images, and video"</strong> " into one decision your agent can use."</p>
                <div class="actions">
                    <a class="button primary" href="/signup">"Start free"</a>
                    <a class="button play-link" href="#tour">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>
                        "Watch 11-sec tour"
                    </a>
                </div>
                <dl class="hero-facts">
                    <div><dt>"$0"</dt><dd>"for reviewers"</dd></div>
                    <div><dt>"25"</dt><dd>"free requests"</dd></div>
                    <div><dt>"1 link"</dt><dd>"to decide"</dd></div>
                </dl>
            </div>
            <figure class="hero-art">
                <img src="/assets/nib-decision-loop-hero.png" alt="Code, image, video, and diff evidence flowing into a human approval and back to the agent." fetchpriority="high">
                <div class="hero-media-tags" aria-hidden="true"><span><i></i>"IMAGE"</span><span><i></i>"VIDEO"</span><span><i></i>"DIFF"</span></div>
                <figcaption class="sr-only">"Nib closes the loop between autonomous software and human judgment."</figcaption>
            </figure>
        </section>
    }
}

#[component]
async fn how_it_works() -> Result {
    view! {
        <section class="shell loop-shell" id="how">
            <h2 class="sr-only">"How Nib works"</h2>
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
        <section class="visual-section" id="tour"><div class="shell">
            <div class="visual-head">
                <div><div class="eyebrow">"11 seconds. The whole loop."</div><h2>"Ask. Review. Decide. Continue."</h2></div>
                <p class="visual-note">"No meeting. No runner waiting. No reviewer account required."</p>
            </div>
            <figure class="film-frame">
                <video class="product-film" controls="controls" preload="metadata" playsinline="playsinline" poster="/assets/tour-01.png" aria-label="How a Nib request moves from agent to human and back">
                    <source src="/assets/nib-product-tour.mp4" type="video/mp4">
                    "Your browser does not support video. The flow is agent, Nib Request, human decision, and agent continuation."
                </video>
                <figcaption class="film-key"><div><b>"1"</b>"Agent packages evidence"</div><div><b>"2"</b>"Human reviews visually"</div><div><b>"3"</b>"Decision resumes work"</div></figcaption>
            </figure>
        </div></section>
        <section class="visual-section" id="evidence"><div class="shell">
            <div class="visual-head">
                <div><div class="eyebrow">"Review anywhere"</div><h2>"Everything they need. Nothing they don't."</h2></div>
                <p class="visual-note">"Images, video, diffs, URLs, comments, and annotations travel together."</p>
            </div>
            <div class="review-showcase">
                <figure class="phone-card">
                    <img src="/assets/nib-mobile-review.png" alt="Nib mobile notification for a deployment review with Approve, Reject, and Open actions." loading="lazy">
                    <figcaption>"Approve from the notification"</figcaption>
                </figure>
                <div class="artifact-board" aria-label="A Nib Request with image, video, diff, and annotation artifacts">
                    <div class="board-top"><div class="board-brand">"nib" <span>"."</span></div><div class="board-status"><i></i>"Ready for Alice"</div></div>
                    <div class="artifact-grid">
                        <div class="artifact-tile image"><div class="mock-screen"></div><div class="annotation-pin">"1"</div><span class="tile-label">"IMAGE · 1440 x 900"</span></div>
                        <div class="artifact-tile video"><div class="play-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg></div><span class="tile-label">"VIDEO · 18 SEC"</span></div>
                        <div class="artifact-tile diff"><div class="diff-line remove"></div><div class="diff-line"></div><div class="diff-line short"></div><span class="tile-label">"DIFF · 12 LINES"</span></div>
                    </div>
                    <div class="feedback-bubble"><div class="feedback-pin">"1"</div><div><strong>"Keep this payment selector."</strong><span>"Alice · annotation on checkout image"</span></div></div>
                </div>
            </div>
        </div></section>
    }
}

#[component]
async fn home_pricing() -> Result {
    view! {
        <section class="home-pricing" id="pricing"><div class="shell">
            <div class="eyebrow">"Simple pricing"</div>
            <div class="pricing-compact">
                <div class="pricing-intro"><div><h2>"Reviewers are free."</h2><p>"Pay for hosted requests, not seats."</p></div><a class="button" href="/pricing">"Compare all plans"</a></div>
                <article class="mini-plan"><h3>"Free"</h3><div class="mini-price">"$0"</div><p>"25 requests / month"</p><span class="plan-dot"></span></article>
                <article class="mini-plan"><h3>"Starter"</h3><div class="mini-price">"$9" <small>"/ mo"</small></div><p>"100 requests / month"</p><span class="plan-dot"></span></article>
                <article class="mini-plan featured"><h3>"Pro"</h3><div class="mini-price">"$24" <small>"/ mo"</small></div><p>"500 requests / month"</p><span class="plan-dot"></span></article>
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
    async fn homepage_explains_the_review_loop_with_visual_media() {
        let response = router()
            .handle(
                Request::builder()
                    .uri("/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        let html = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let html = String::from_utf8(html.to_vec()).unwrap();

        assert!(html.contains("Your agent did the work. You make the call."));
        assert!(html.contains("/assets/nib-decision-loop-hero.png"));
        assert!(html.contains("/assets/nib-product-tour.mp4"));
        assert!(html.contains("/assets/nib-mobile-review.png"));
        assert!(html.contains("Agent creates a Nib Request"));
        assert!(html.contains("Everything they need. Nothing they don't."));
        assert_eq!(html.matches("<video").count(), 1);
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
