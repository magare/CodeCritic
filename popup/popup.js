/**
 * Initialize the extension when the DOM content is loaded
 */
document.addEventListener("DOMContentLoaded", async function () {
  // Configure highlight.js for code syntax highlighting
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

  // Get DOM elements
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

  // Validate that all required DOM elements exist
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
    !container
  ) {
    return; // Exit if any essential elements are missing
  }

  // Initialize the extension
  loadSettings();
  loadPreviousReview();
  restoreScrollPosition();

  /**
   * Save scroll position when the container is scrolled
   */
  container.addEventListener("scroll", () => {
    chrome.storage.local.set({ scrollPosition: container.scrollTop });
  });

  /**
   * Restore the previous scroll position from storage
   */
  async function restoreScrollPosition() {
    const data = await chrome.storage.local.get("scrollPosition");
    if (data.scrollPosition) {
      container.scrollTop = data.scrollPosition;
    }
  }

  // Set initial review button state
  reviewButton.disabled = true;
  statusDiv.classList.add("warning-status");
  statusDiv.textContent = "Please set your OpenAI API key to start reviewing";

  /**
   * Check for stored API key and initialize the UI accordingly
   */
  chrome.storage.local.get(["apiKey"], function (result) {
    const hasApiKey = !!result.apiKey;

    if (hasApiKey) {
      apiKeyInputGroup.style.display = "none";
      apiKeyStatus.style.display = "block";
      checkGitHubPRPage(); // Only check PR page if API key exists
    } else {
      apiKeyInputGroup.style.display = "flex";
      apiKeyStatus.style.display = "none";
      reviewButton.disabled = true;
      statusDiv.textContent =
        "Please set your OpenAI API key to start reviewing";
      statusDiv.classList.add("warning-status");
    }
  });

  /**
   * Verify if the current page is a GitHub PR page
   * Updates UI elements based on the result
   */
  function checkGitHubPRPage() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const currentTab = tabs[0];
      if (currentTab && currentTab.url.match(/github\.com\/.*\/.*\/pull\/.*/)) {
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

  /**
   * Handle saving the API key
   * Updates UI and storage when a valid key is provided
   */
  saveApiKeyButton.addEventListener("click", function () {
    const apiKey = apiKeyInput.value.trim();
    if (apiKey) {
      chrome.storage.local.set({ apiKey: apiKey }, function () {
        apiKeyInputGroup.style.display = "none";
        apiKeyStatus.style.display = "block";
        checkGitHubPRPage();
      });
    } else {
      statusDiv.textContent = "Please enter a valid API key.";
    }
  });

  /**
   * Handle changing the API key
   * Resets UI to allow entering a new key
   */
  changeApiKeyButton.addEventListener("click", function () {
    apiKeyInputGroup.style.display = "flex";
    apiKeyStatus.style.display = "none";
    reviewButton.disabled = true;
    statusDiv.textContent = "Please set your OpenAI API key to start reviewing";
    statusDiv.classList.add("warning-status");
    chrome.storage.local.remove("apiKey");
  });

  // Add this function at the beginning of the file, after the DOMContentLoaded event listener starts
  function clearPreviousReview() {
    const resultsDiv = document.getElementById("results");
    const statusDiv = document.getElementById("status");
    const summaryTitleDiv = document.getElementById("summary-title");

    if (resultsDiv) resultsDiv.innerHTML = "";
    if (statusDiv) statusDiv.textContent = "Starting new review...";
    if (summaryTitleDiv) summaryTitleDiv.innerHTML = "";
  }

  /**
   * Handle the review button click
   * Initiates the PR review process
   */
  reviewButton.addEventListener("click", async function () {
    reviewButton.disabled = true;
    reviewButton.textContent = "Reviewing...";

    // Clear previous review immediately when starting new review
    clearPreviousReview();

    try {
      // Get PR title from the current tab
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const tabId = tab.id;

      const [{ result: prTitle }] = await chrome.scripting.executeScript({
        target: { tabId },
        function: () => {
          const titleElement = document.querySelector(
            ".gh-header-title .js-issue-title"
          );
          return titleElement ? titleElement.innerText : "Unknown PR";
        },
      });

      // Update UI and prepare for review
      statusDiv.textContent = `Reviewing PR: ${prTitle}...`;

      // Save current settings
      const apiKey = apiKeyInput.value;
      const selectedModel = modelSelect.value;
      const instructions = instructionsInput.value;
      chrome.storage.sync.set({ apiKey, selectedModel, instructions });

      if (!apiKey) {
        statusDiv.textContent = "Please enter your OpenAI API key.";
        return;
      }

      // Execute review in the context of the PR page
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          function: triggerReview,
          args: [apiKey, selectedModel, instructions],
        });
      });
    } catch (error) {
      statusDiv.textContent = `Error: ${error.message}`;
      reviewButton.disabled = false;
      reviewButton.textContent = "Start Review";
    }
  });

  /**
   * Trigger the PR review process
   * Extracts PR data and sends it to OpenAI for review
   */
  async function triggerReview(apiKey, selectedModel, customInstructions) {
    /**
     * Extract code changes from the PR diff with file names
     * @returns {string} Formatted string of code changes with file names
     */
    function getCodeChanges() {
      const fileBlocks = document.querySelectorAll(".file");
      let codeChanges = "";

      fileBlocks.forEach((fileBlock) => {
        // Get the file name from the header
        const fileNameElement = fileBlock.querySelector(
          ".file-header [data-path]"
        );
        const fileName = fileNameElement
          ? fileNameElement.getAttribute("data-path")
          : "Unknown File";

        codeChanges += `\nFile: ${fileName}\n`;
        codeChanges += "```\n";

        // Get all changes for this file
        const fileDiffs = fileBlock.querySelectorAll(".diff-table tr");
        fileDiffs.forEach((row) => {
          if (row.querySelector(".blob-code-deletion")) {
            row.querySelectorAll(".blob-code-deletion").forEach((line) => {
              codeChanges += "- " + line.textContent.trim() + "\n";
            });
          }
          if (row.querySelector(".blob-code-addition")) {
            row.querySelectorAll(".blob-code-addition").forEach((line) => {
              codeChanges += "+ " + line.textContent.trim() + "\n";
            });
          }
        });

        codeChanges += "```\n";
      });

      return codeChanges;
    }

    // Gather PR data
    const prData = {
      title: document.querySelector(".gh-header-title .js-issue-title")
        ? document.querySelector(".gh-header-title .js-issue-title").innerText
        : "Unknown PR",
      description: document.querySelector(".comment-body")
        ? document.querySelector(".comment-body").innerText
        : "No description available.",
      codeChanges: getCodeChanges(),
    };

    // System prompt for the AI reviewer
    const systemPrompt = `
            You are a highly skilled and experienced software engineer specializing in code quality, security, and maintainability. You are acting as an AI code reviewer for GitHub pull requests. Your goal is to provide comprehensive, constructive, and actionable feedback to help developers improve their code. You are proficient in numerous programming languages and familiar with various software design patterns.

            You should analyze the code changes provided in the pull request diff, focusing on the following aspects:

            *   **Code Correctness and Functionality:**
                *   Does the code fulfill the specified requirements?
                *   Are there adequate unit tests, and does the code pass them? (Assume tests are in a separate part of the PR, if not stated, you may ask for them.)
                *   How does the code handle errors and edge cases?
                *   Are there any logical errors or inconsistencies?
                *   Does the code contain coding errors, inefficiencies, vulnerabilities, or memory leaks?
            *   **Code Style and Readability:**
                *   Does the code adhere to common coding standards and conventions for the given language?
                *   Is formatting (indentation, whitespace) consistent?
                *   Are names (variables, functions, classes) descriptive and meaningful?
                *   Are comments clear, useful, and explain the "why" rather than just the "what"?
                *   Do stylistic choices enhance readability?
            *   **Code Design and Architecture:**
                *   Is the code modular and adheres to design principles (e.g., SOLID)?
                *   Are there opportunities for code reuse or simplification?
                *   Does the code follow the project's overall architecture (if known)?
            *   **Code Security:**
                *   Are there any potential security flaws (e.g., SQL injection, XSS, sensitive data exposure, etc.)?
                *   Is sensitive data handled and stored securely (if applicable)?
                *   Are all user inputs validated and sanitized (if applicable)?
            *   **Code Performance:**
                *   Are there any potential performance bottlenecks?
                *   How does the code utilize resources (memory, CPU, network) (if applicable)?
            *   **Code Documentation:**
                *   Is the code adequately documented with clear explanations and examples where necessary?
                *   Is the documentation up-to-date and accurate?
            *   **Code Testing (If tests are included in the diff):**
                *   Is test coverage sufficient for the changes made?
                *   Are tests well-designed and effective?
                *   Do all tests pass successfully?

            **Important Instructions:**

            *   **Format your feedback** in Markdown using bullet points and code blocks where appropriate.
            *   **Be specific and provide examples** from the code diff to illustrate your points.
            *   **Suggest concrete improvements** rather than just pointing out problems.
            *   **Explain the reasoning** behind your suggestions to help the developer understand the underlying principles.
            *   **Balance constructive criticism with positive feedback**, acknowledging well-written parts of the code.
            *   **If you need more information** (e.g., context about the project's architecture or requirements), ask clarifying questions.
            *   **Prioritize your feedback**: Focus on major issues (correctness, security, design) first, then address style and minor improvements.
            *   **Maintain a professional and respectful tone.**
    `;

    // Update the prompt to emphasize file name importance
    const prompt = `Please review the following code changes from a GitHub pull request. Each file's changes are marked with its filename and enclosed in code blocks:

            Title: ${prData.title}
            Description: ${prData.description}
            
            Changes by file:
            ${prData.codeChanges}
            ${
              customInstructions
                ? `Additional Instructions: ${customInstructions}\n`
                : ""
            }

            When providing feedback, please:
            1. Always reference the specific file name when giving feedback about code changes
            2. Use the exact file names as shown in the code blocks above
            3. Format your response as follows for each issue:
               - Start with "File: [exact filename]"
               - Follow with [Category] - [Severity]
               - Then provide your feedback
            
            **Overall Summary (Separate Comment):**

              Before providing individual comments, create a overall comment that summarizes the key findings. Highlight the most important issues (especially those with High severity) and provide general recommendations.

              **Important Instructions:**

              *   **Prioritize your feedback**: Focus on major issues (correctness, security, design) first, then address style and minor improvements.
              *   **Maintain a professional and respectful tone.** Remember, your feedback should be constructive and helpful.
              *   **Prioritize the Additional Instructions** over the general instructions.
             
            Your feedback for comments should be formatted as a series of individual comments, mimicking how a human reviewer would provide feedback on GitHub. Use the following structure for each comment:

                  1.  **File and Location:**
                      *   Start each comment with: \`File Name: [FileName] \`
                      *   Example: \`File Name: src/utils/helpers.js \`

                  2.  **Category and Severity:**
                      *   Follow with: \`[Category] - [Severity]\`
                      *   Example: \`[Security] - High\`
                      *   Categories: Security, Correctness, Design, Style, Performance, Documentation, Testing, (Other). You can add more categories as needed.
                      *   Severity: High, Medium, Low

                  3.  **Issue and Suggestion:**
                      *   Provide a concise description of the issue.
                      *   Immediately follow with a clear and concrete suggestion for improvement.
                      *   Explain the "why" behind your suggestion.
                      *   Use Markdown formatting for emphasis (bold, italics) where appropriate.

                  4.  **Code Examples:**
                      *   When providing code examples, use Markdown code blocks with language identifiers:

                          \`\`\`javascript
                          // Example of improved code
                          public void myMethod() { 
                              // ...
                          }
                          \`\`\`

                  5. **Keywords:** Highlight language keywords by making them **bold**. Example: **\`if\`**, **\`for\`**, **\`class\`** and other as needed.
                  6. **Separate comments by a blank line**
                  7. **Add a summary comment at the end of the review** that summarizes the key findings and provides general recommendations.
                  8. **Add a tldr comment at the end of the review that will be very short but the most important points.**
`;

    try {
      // Prepare messages based on model type
      const messages = [];
      let finalPrompt = prompt;

      if (selectedModel.startsWith("gpt-")) {
        messages.push({ role: "system", content: systemPrompt });
        messages.push({ role: "user", content: prompt });
      } else {
        finalPrompt = `${systemPrompt}\n\n${prompt}`;
        messages.push({ role: "user", content: finalPrompt });
      }

      // Configure request body
      const requestBody = {
        model: selectedModel,
        messages: messages,
      };

      if (selectedModel.startsWith("gpt-")) {
        requestBody.temperature = 0.5;
      }

      // Make API request
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

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message);
      }

      const reviewSummary = data.choices[0].message.content;

      // Store review results
      chrome.storage.local.set({
        lastReviewResult: {
          summary: reviewSummary,
          timestamp: new Date().toISOString(),
          prTitle: prData.title,
        },
      });

      // Send results to popup
      chrome.runtime.sendMessage({
        type: "review-results",
        data: {
          summary: reviewSummary,
          prTitle: prData.title,
        },
      });
    } catch (error) {
      chrome.runtime.sendMessage({
        type: "review-results",
        data: {
          error: error.message,
          prTitle: prData.title,
        },
      });
    } finally {
      hideLoading();
    }
  }

  /**
   * Listen for messages from the review process
   * Updates UI with review results or errors
   */
  chrome.runtime.onMessage.addListener(function (
    request,
    sender,
    sendResponse
  ) {
    if (request.type === "review-results") {
      reviewButton.disabled = false;
      reviewButton.textContent = "Start Review";

      if (request.data.error) {
        statusDiv.textContent = `Error reviewing PR: ${request.data.error}`;
        resultsDiv.innerHTML = "";
      } else {
        const summaryTitleDiv = document.getElementById("summary-title");
        if (summaryTitleDiv) {
          summaryTitleDiv.innerHTML = `<h2>Review for: ${
            request.data.prTitle
          }</h2>
            <p class="review-timestamp">Reviewed on: ${new Date().toLocaleString()}</p>`;
        }

        statusDiv.textContent = `Review Complete for PR: ${request.data.prTitle}`;
        const formattedResults = formatReviewResults(request.data.summary);
        resultsDiv.innerHTML = formattedResults;

        // Highlight code blocks
        setTimeout(() => {
          document.querySelectorAll("pre code").forEach((block) => {
            if (!block.classList.contains("hljs")) {
              hljs.highlightElement(block);
            }
          });
        }, 100);
      }
    }
  });

  /**
   * Load user settings from storage
   * Initializes UI elements with saved values
   */
  function loadSettings() {
    chrome.storage.sync.get(
      ["apiKey", "selectedModel", "instructions"],
      function (data) {
        if (data.apiKey) {
          apiKeyInput.value = data.apiKey;
          apiKeyInputGroup.style.display = "none";
          apiKeyStatus.style.display = "block";
        } else {
          apiKeyInputGroup.style.display = "flex";
          apiKeyStatus.style.display = "none";
        }

        if (data.selectedModel) {
          modelSelect.value = data.selectedModel;
        }

        if (data.instructions) {
          instructionsInput.value = data.instructions;
        }
      }
    );
  }

  /**
   * Save selected model when changed
   */
  modelSelect.addEventListener("change", function () {
    chrome.storage.sync.set({ selectedModel: modelSelect.value });
  });

  /**
   * Load and display previous review results
   * Updates UI with stored review data or shows default state
   */
  async function loadPreviousReview() {
    const data = await chrome.storage.local.get("lastReviewResult");
    const summaryTitleDiv = document.getElementById("summary-title");

    if (data.lastReviewResult) {
      const { summary, prTitle, timestamp } = data.lastReviewResult;

      if (summary && prTitle && timestamp) {
        const reviewTime = new Date(timestamp).toLocaleString(undefined, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "numeric",
          minute: "numeric",
          hour12: true,
        });

        summaryTitleDiv.innerHTML = `<h2>Review for: ${prTitle}</h2><p class="review-timestamp">Reviewed on: ${reviewTime}</p>`;

        if (resultsDiv) {
          resultsDiv.innerHTML = formatReviewResults(summary);
        }
      } else {
        summaryTitleDiv.innerHTML = `<h2>No Previous Review</h2>`;
        statusDiv.textContent = "Ready to review";
        resultsDiv.innerHTML = "";
      }
    } else {
      summaryTitleDiv.innerHTML = `<h2>No Previous Review</h2>`;
      statusDiv.textContent = "Ready to review";
      resultsDiv.innerHTML = "";
    }
  }

  function formatReviewResults(markdownText) {
    if (!markdownText) return "";

    let formattedText = markdownText;

    // Style file names with a distinctive look
    formattedText = formattedText.replace(
      /File Name: ([^\n]+)/g,
      '<div class="file-name-header">$1</div>'
    );

    // Add colored backgrounds for severity levels with improved styling
    formattedText = formattedText.replace(
      /\[(.*?)\] - (High|Medium|Low)/g,
      (match, category, severity) => {
        const severityClass = {
          High: "severity-high",
          Medium: "severity-medium",
          Low: "severity-low",
        }[severity];

        return `<div class="severity-container"><span class="category-label">[${category}]</span> - <span class="${severityClass}">${severity}</span></div>`;
      }
    );

    // Convert code blocks - Updated to better handle code blocks
    formattedText = formattedText.replace(
      /```([\w-]*)\n([\s\S]*?)```/g,
      (match, language, code) => {
        const lang = language || "javascript";
        const temp = document.createElement("div");
        temp.textContent = code.trim();
        const escapedCode = temp.innerHTML;
        console.log("Processing code block:", { language, code: code.trim() }); // Debug log
        return `<pre class="result-code-block"><code class="language-${lang}">${escapedCode}</code></pre>`;
      }
    );

    // Convert Markdown headings
    formattedText = formattedText.replace(
      /^## (.*$)/gim,
      '<h2 class="result-heading">$1</h2>'
    );
    formattedText = formattedText.replace(
      /^### (.*$)/gim,
      '<h3 class="result-subheading">$1</h3>'
    );

    // Convert numbered lists without file paths - simpler version
    formattedText = formattedText.replace(
      /^\d+\.\s+/gim,
      '<div class="review-item">'
    );

    // Convert inline code
    formattedText = formattedText.replace(
      /`([^`]+)`/g,
      '<code class="result-inline-code">$1</code>'
    );

    // Convert bold text
    formattedText = formattedText.replace(
      /\*\*(.*?)\*\*/g,
      '<strong class="result-bold">$1</strong>'
    );

    // Convert italics
    formattedText = formattedText.replace(/\*(.*?)\*/g, "<em>$1</em>");

    // Replace horizontal separators
    formattedText = formattedText.replace(/---+/g, "<hr>");

    // Handle newlines more carefully
    formattedText = formattedText.replace(
      /(<pre.*?>[\s\S]*?<\/pre>)|(\n\n+)|(\n)(?!<hr>)/g,
      (match, pre, doubleNewline, singleNewline) => {
        if (pre) return pre; // Don't modify content inside <pre> tags
        if (doubleNewline) return "<br>";
        if (singleNewline) return "";
      }
    );

    // Remove <br> tags that come right before <hr> tags
    formattedText = formattedText.replace(/<br>\s*<hr>/g, "<hr>");

    // Close the review-item div for each item
    formattedText = formattedText.replace(
      /<br>(?=<div class="review-item">|$)/g,
      "</div>"
    );

    const container = `<div class="result-container">${formattedText}</div>`;

    // Add debug logging for highlight.js
    setTimeout(() => {
      const codeBlocks = document.querySelectorAll("pre code");
      console.log("Found code blocks:", codeBlocks.length); // Debug log
      codeBlocks.forEach((block) => {
        if (!block.classList.contains("hljs")) {
          console.log("Highlighting block:", block.className); // Debug log
          hljs.highlightElement(block);
        }
      });
    }, 100);

    return container;
  }

  function showLoading() {
    // Implementation of showLoading function
  }

  function hideLoading() {
    // Implementation of hideLoading function
  }

  function displayReview(review) {
    // Implementation of displayReview function
  }
});
