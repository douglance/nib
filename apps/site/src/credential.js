function initializeCredential() {
  const tokenPanel = document.querySelector("[data-token-panel]");
  const tokenValue = document.querySelector("[data-token-value]");
  const tokenCopy = document.querySelector("[data-copy-token]");
  const tokenStatus = document.querySelector("[data-token-status]");
  const signupPanel = document.querySelector("[data-signup-panel]");
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const token = fragment.get("token");

  if (!token?.startsWith("nib_live_") || !tokenPanel || !tokenValue) return;
  tokenValue.textContent = token;
  tokenPanel.removeAttribute("hidden");
  signupPanel?.setAttribute("hidden", "");
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);

  tokenCopy?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(token);
      if (tokenStatus) tokenStatus.textContent = "Token copied. Save it now; Nib will not show it again.";
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(tokenValue);
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (tokenStatus) tokenStatus.textContent = "Copy the selected token and save it now.";
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeCredential);
} else {
  initializeCredential();
}
