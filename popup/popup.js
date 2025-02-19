document.addEventListener("DOMContentLoaded", async () => {
  // Configure highlight.js for syntax highlighting
  hljs.configure({
    ignoreUnescapedHTML: true,
    languages: [
      "javascript",
      "typescript",
      "python",
      "java",
      "go",
      "ruby",
      "xml",
      "css",
      "c",
      "cpp",
      "csharp",
      "rust",
      "swift",
      "kotlin",
      "sql",
      "bash",
      "yaml",
      "json",
      "php",
    ],
  });

  // DOM Element references
  const apiKeyInput = document.getElementById("api-key");
  const saveApiKeyButton = document.getElementById("save-api-key");
  const modelSelect = document.getElementById("model-select");
  const instructionsInput = document.getElementById("instructions");
  const reviewButton = document.getElementById("review-button");
  const statusDiv = document.getElementById("status");
  const resultsDiv = document.getElementById("results");
  const apiKeyInputGroup = document.getElementById("api-key-input-group");
  const apiKeyStatus = document.getElementById("api-key-status");
  const changeApiKeyButton = document.getElementById("change-api-key");
  const container = document.querySelector(".container");
  const themeToggleButton = document.getElementById("theme-toggle");
  const historyNav = document.getElementById("history-navigation");

  if (
    !apiKeyInput ||
    !saveApiKeyButton ||
    !modelSelect ||
    !instructionsInput ||
    !reviewButton ||
    !statusDiv ||
    !resultsDiv ||
    !apiKeyInputGroup ||
    !apiKeyStatus ||
    !changeApiKeyButton ||
    !container ||
    !themeToggleButton ||
    !historyNav
  ) {
    return;
  }

  // Global variable for history navigation offset (0 = latest review)
  let currentReviewOffset = 0;

  // Theme definitions
  const themeClasses = [
    "theme-default", // default uses :root values
    "theme-dark",
    "theme-blue",
    "theme-green",
    "theme-purple",
  ];

  chrome.storage.sync.get(["themeIndex"], (data) => {
    let currentTheme = data.themeIndex !== undefined ? data.themeIndex : 0;
    applyTheme(currentTheme);
  });

  function applyTheme(index) {
    themeClasses.forEach((cls) => container.classList.remove(cls));
    const newTheme = themeClasses[index];
    container.classList.add(newTheme);
    chrome.storage.sync.set({ themeIndex: index });
  }

  themeToggleButton.addEventListener("click", () => {
    chrome.storage.sync.get(["themeIndex"], (data) => {
      let currentTheme = data.themeIndex !== undefined ? data.themeIndex : 0;
      let nextTheme = (currentTheme + 1) % themeClasses.length;
      applyTheme(nextTheme);
    });
  });

  loadSettings();
  loadPreviousReview();
  restoreScrollPosition();
  reviewButton.disabled = true;
  statusDiv.classList.add("warning-status");
  statusDiv.textContent = "Please set your OpenAI API key to start reviewing";

  container.addEventListener("scroll", () => {
    chrome.storage.local.set({ scrollPosition: container.scrollTop });
  });

  async function restoreScrollPosition() {
    const { scrollPosition } = await chrome.storage.local.get("scrollPosition");
    if (scrollPosition) container.scrollTop = scrollPosition;
  }

  function checkGitHubPRPage() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentTab = tabs[0];
      if (currentTab && /github\.com\/.*\/.*\/pull\/.*/.test(currentTab.url)) {
        reviewButton.disabled = false;
        statusDiv.textContent = "Ready to review PR";
        statusDiv.classList.remove("warning-status");
      } else {
        reviewButton.disabled = true;
        statusDiv.textContent = "Not a GitHub PR page";
        statusDiv.classList.add("warning-status");
      }
    });
  }

  chrome.storage.local.get(["apiKey"], (result) => {
    if (result.apiKey) {
      apiKeyInputGroup.style.display = "none";
      apiKeyStatus.style.display = "block";
      checkGitHubPRPage();
    } else {
      apiKeyInputGroup.style.display = "flex";
      apiKeyStatus.style.display = "none";
      reviewButton.disabled = true;
      statusDiv.textContent =
        "Please set your OpenAI API key to start reviewing";
      statusDiv.classList.add("warning-status");
    }
  });

  saveApiKeyButton.addEventListener("click", () => {
    const apiKey = apiKeyInput.value.trim();
    if (apiKey) {
      chrome.storage.local.set({ apiKey }, () => {
        apiKeyInputGroup.style.display = "none";
        apiKeyStatus.style.display = "block";
        checkGitHubPRPage();
      });
    } else {
      statusDiv.textContent = "Please enter a valid API key.";
    }
  });

  changeApiKeyButton.addEventListener("click", () => {
    apiKeyInputGroup.style.display = "flex";
    apiKeyStatus.style.display = "none";
    reviewButton.disabled = true;
    statusDiv.textContent = "Please set your OpenAI API key to start reviewing";
    statusDiv.classList.add("warning-status");
    chrome.storage.local.remove("apiKey");
  });

  function clearPreviousReview() {
    resultsDiv.innerHTML = "";
    statusDiv.textContent = "Starting new review...";
    const summaryTitleDiv = document.getElementById("summary-title");
    if (summaryTitleDiv) summaryTitleDiv.innerHTML = "";
  }

  reviewButton.addEventListener("click", async () => {
    reviewButton.disabled = true;
    reviewButton.textContent = "Reviewing...";
    clearPreviousReview();

    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const tabId = tab.id;
      const [{ result: prTitle }] = await chrome.scripting.executeScript({
        target: { tabId },
        function: () => {
          const titleElem = document.querySelector(
            ".gh-header-title .js-issue-title"
          );
          return titleElem ? titleElem.innerText : "Unknown PR";
        },
      });
      statusDiv.textContent = `Reviewing PR: ${prTitle}...`;

      let apiKey = apiKeyInput.value.trim();
      if (!apiKey) {
        const stored = await chrome.storage.local.get("apiKey");
        apiKey = stored.apiKey;
      }
      const selectedModel = modelSelect.value;
      const instructions = instructionsInput.value;
      chrome.storage.sync.set({ selectedModel, instructions });
      if (!apiKey) {
        statusDiv.textContent = "Please enter your OpenAI API key.";
        reviewButton.disabled = false;
        reviewButton.textContent = "Start Review";
        return;
      }

      // Execute the review function in the PR page and wait for its returned result.
      const [injectedResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: triggerReview,
        args: [apiKey, selectedModel, instructions],
      });
      const resultData = injectedResult.result;
      reviewButton.disabled = false;
      reviewButton.textContent = "Start Review";

      if (resultData.error) {
        statusDiv.textContent = `Error reviewing PR: ${resultData.error}`;
        resultsDiv.innerHTML = "";
      } else {
        statusDiv.textContent = `Review Complete for PR: ${resultData.prTitle}`;
        const summaryTitleDiv = document.getElementById("summary-title");
        const reviewTime = new Date(resultData.timestamp).toLocaleString();
        summaryTitleDiv.innerHTML = `<h2>Review for: ${resultData.prTitle}</h2>
          <p class="review-timestamp">Reviewed on: ${reviewTime}</p>`;
        resultsDiv.innerHTML = formatReviewResults(resultData.summary);
        // Update review history
        chrome.storage.local.get("reviewHistory", (storedData) => {
          let reviewHistory = storedData.reviewHistory || [];
          reviewHistory.push({
            summary: resultData.summary,
            timestamp: resultData.timestamp,
            prTitle: resultData.prTitle,
          });
          if (reviewHistory.length > 10) reviewHistory.shift();
          chrome.storage.local.set({ reviewHistory }, () => {
            currentReviewOffset = 0;
            updateHistoryNavigation();
          });
        });
        setTimeout(() => {
          document.querySelectorAll("pre code").forEach((block) => {
            if (!block.classList.contains("hljs")) hljs.highlightElement(block);
          });
        }, 100);
      }
    } catch (error) {
      statusDiv.textContent = `Error: ${error.message}`;
      reviewButton.disabled = false;
      reviewButton.textContent = "Start Review";
    }
  });

  // Injected function now returns the review result instead of sending a message.
  async function triggerReview(apiKey, selectedModel, customInstructions) {
    function getCodeChanges() {
      const fileBlocks = document.querySelectorAll(".file");
      let changes = "";
      fileBlocks.forEach((block) => {
        const fileNameElem = block.querySelector(".file-header [data-path]");
        const fileName = fileNameElem
          ? fileNameElem.getAttribute("data-path")
          : "Unknown File";
        changes += `\nFile: ${fileName}\n\`\`\`\n`;
        block.querySelectorAll(".diff-table tr").forEach((row) => {
          row.querySelectorAll(".blob-code-deletion").forEach((line) => {
            changes += `- ${line.textContent.trim()}\n`;
          });
          row.querySelectorAll(".blob-code-addition").forEach((line) => {
            changes += `+ ${line.textContent.trim()}\n`;
          });
        });
        changes += "```\n";
      });
      return changes;
    }

    const prData = {
      title:
        document.querySelector(".gh-header-title .js-issue-title")?.innerText ||
        "Unknown PR",
      description:
        document.querySelector(".comment-body")?.innerText ||
        "No description available.",
      codeChanges: getCodeChanges(),
    };

    const systemPrompt = `
You are an experienced software engineer specializing in code quality, security, and maintainability.
Act as an AI code reviewer for GitHub pull requests.
Analyze the provided code changes and offer constructive, actionable feedback with examples, prioritizing major issues.
    `;
    const prompt = `
Title: ${prData.title}
Description: ${prData.description}

Changes by file:
${prData.codeChanges}
${customInstructions ? `Additional Instructions: ${customInstructions}\n` : ""}
When providing feedback, please:
1. Reference the specific file name.
2. Use the exact file names as shown.
3. Format your feedback with:
   - "File: [filename]"
   - "[Category] - [Severity]"
   - A description and suggestion with code examples in Markdown.
Include an overall summary comment and a brief TL;DR at the end.
    `;
    try {
      const messages = selectedModel.startsWith("gpt-")
        ? [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ]
        : [{ role: "user", content: `${systemPrompt}\n\n${prompt}` }];
      const requestBody = {
        model: selectedModel,
        messages,
        ...(selectedModel.startsWith("gpt-") && { temperature: 0.5 }),
      };

      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        }
      );

      if (!response.ok) throw new Error(`API Error: ${response.status}`);
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      const reviewSummary = data.choices[0].message.content;
      return {
        summary: reviewSummary,
        prTitle: prData.title,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return { error: error.message, prTitle: prData.title };
    }
  }

  // Format markdown review results into HTML.
  function formatReviewResults(markdownText) {
    if (!markdownText) return "";
    let formattedText = markdownText;
    formattedText = formattedText.replace(
      /\[(.*?)\]\s*-\s*\[(High(?:\s*Severity)?|Medium(?:\s*Severity)?|Low(?:\s*Severity)?)\]/g,
      (match, category, severity) => {
        const severityKey = severity.replace(/\s*Severity/, "");
        const severityClass = {
          High: "severity-high",
          Medium: "severity-medium",
          Low: "severity-low",
        }[severityKey];
        return `<div class="severity-container"><span class="category-label">[${category}]</span> - <span class="${severityClass}">${severity}</span></div>`;
      }
    );
    formattedText = formattedText.replace(
      /```([\w-]*)\n([\s\S]*?)```/g,
      (match, language, code) => {
        const lang = language || "javascript";
        const temp = document.createElement("div");
        temp.textContent = code.trim();
        const escapedCode = temp.innerHTML;
        return `<pre class="result-code-block"><code class="language-${lang}">${escapedCode}</code></pre>`;
      }
    );
    formattedText = formattedText.replace(
      /^## (.*$)/gim,
      '<h2 class="result-heading">$1</h2>'
    );
    formattedText = formattedText.replace(
      /^### (.*$)/gim,
      '<h3 class="result-subheading">$1</h3>'
    );
    formattedText = formattedText.replace(
      /^\d+\.\s+/gim,
      '<div class="review-item">'
    );
    formattedText = formattedText.replace(
      /`([^`]+)`/g,
      '<code class="result-inline-code">$1</code>'
    );
    formattedText = formattedText.replace(
      /\*\*(.*?)\*\*/g,
      '<strong class="result-bold">$1</strong>'
    );
    formattedText = formattedText.replace(/---+/g, "<hr>");
    formattedText = formattedText.replace(
      /(<pre.*?>[\s\S]*?<\/pre>)|(\n\n+)|(\n)(?!<hr>)/g,
      (match, pre, doubleNewline, singleNewline) => {
        if (pre) return pre;
        if (doubleNewline) return "<br>";
        if (singleNewline) return "";
      }
    );
    formattedText = formattedText.replace(/<br>\s*<hr>/g, "<hr>");
    formattedText = formattedText.replace(
      /<br>(?=<div class="review-item">|$)/g,
      "</div>"
    );
    setTimeout(() => {
      document.querySelectorAll("pre code").forEach((block) => {
        hljs.highlightElement(block);
      });
    }, 100);
    return `<div class="result-container">${formattedText}</div>`;
  }

  function updateHistoryNavigation() {
    chrome.storage.local.get("reviewHistory", (data) => {
      const history = data.reviewHistory || [];
      if (history.length < 2) {
        historyNav.style.display = "none";
        return;
      }
      historyNav.style.display = "flex";
      historyNav.innerHTML = "";
      if (currentReviewOffset === 0) {
        const backBtn = document.createElement("button");
        backBtn.id = "nav-back";
        backBtn.textContent = "-1";
        backBtn.addEventListener("click", () => {
          if (
            currentReviewOffset < history.length - 1 &&
            currentReviewOffset < 10
          ) {
            currentReviewOffset++;
            renderReviewFromHistory();
            updateHistoryNavigation();
          }
        });
        historyNav.appendChild(backBtn);
      } else {
        const resetBtn = document.createElement("button");
        resetBtn.id = "nav-reset";
        resetBtn.textContent = "0";
        resetBtn.addEventListener("click", () => {
          currentReviewOffset = 0;
          renderReviewFromHistory();
          updateHistoryNavigation();
        });
        historyNav.appendChild(resetBtn);
        if (
          currentReviewOffset < history.length - 1 &&
          currentReviewOffset < 10
        ) {
          const backBtn = document.createElement("button");
          backBtn.id = "nav-back";
          backBtn.textContent = `-${currentReviewOffset + 1}`;
          backBtn.addEventListener("click", () => {
            if (
              currentReviewOffset < history.length - 1 &&
              currentReviewOffset < 10
            ) {
              currentReviewOffset++;
              renderReviewFromHistory();
              updateHistoryNavigation();
            }
          });
          historyNav.appendChild(backBtn);
        }
      }
    });
  }

  function renderReviewFromHistory() {
    chrome.storage.local.get("reviewHistory", (data) => {
      const history = data.reviewHistory || [];
      if (history.length === 0) return;
      const latestIndex = history.length - 1;
      const index = latestIndex - currentReviewOffset;
      const review = history[index];
      const summaryTitleDiv = document.getElementById("summary-title");
      if (review) {
        const reviewTime = new Date(review.timestamp).toLocaleString(
          undefined,
          {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "numeric",
            minute: "numeric",
            hour12: true,
          }
        );
        summaryTitleDiv.innerHTML = `<h2>Review for: ${review.prTitle}</h2>
          <p class="review-timestamp">Reviewed on: ${reviewTime}</p>`;
        resultsDiv.innerHTML = formatReviewResults(review.summary);
      }
    });
  }

  function loadSettings() {
    chrome.storage.sync.get(
      ["apiKey", "selectedModel", "instructions"],
      (data) => {
        if (data.apiKey) {
          apiKeyInput.value = data.apiKey;
          apiKeyInputGroup.style.display = "none";
          apiKeyStatus.style.display = "block";
        } else {
          apiKeyInputGroup.style.display = "flex";
          apiKeyStatus.style.display = "none";
        }
        if (data.selectedModel) modelSelect.value = data.selectedModel;
        if (data.instructions) instructionsInput.value = data.instructions;
      }
    );
  }

  function loadPreviousReview() {
    chrome.storage.local.get("reviewHistory", (data) => {
      const history = data.reviewHistory || [];
      const summaryTitleDiv = document.getElementById("summary-title");
      if (history.length > 0) {
        currentReviewOffset = 0;
        const latestReview = history[history.length - 1];
        const reviewTime = new Date(latestReview.timestamp).toLocaleString(
          undefined,
          {
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "numeric",
            minute: "numeric",
            hour12: true,
          }
        );
        summaryTitleDiv.innerHTML = `<h2>Review for: ${latestReview.prTitle}</h2>
          <p class="review-timestamp">Reviewed on: ${reviewTime}</p>`;
        resultsDiv.innerHTML = formatReviewResults(latestReview.summary);
        updateHistoryNavigation();
      } else {
        summaryTitleDiv.innerHTML = `<h2>No Previous Review</h2>`;
        statusDiv.textContent = "Ready to review";
        resultsDiv.innerHTML = "";
      }
    });
  }
});
