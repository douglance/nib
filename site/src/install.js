const button = document.querySelector("[data-copy-install]");
const prompt = document.querySelector("#install-prompt");
const status = document.querySelector("#install-status");

if (button instanceof HTMLButtonElement && prompt instanceof HTMLElement) {
  button.addEventListener("click", async () => {
    const text = prompt.textContent?.trim() ?? "";

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(prompt);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("copy");
      selection?.removeAllRanges();
    }

    button.textContent = "Copied";
    if (status) status.textContent = "Paste the prompt into your agent.";

    window.setTimeout(() => {
      button.textContent = "Copy install prompt";
      if (status) status.textContent = "";
    }, 4000);
  });
}
