document.addEventListener("DOMContentLoaded", function () {
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

  // Load saved settings and previous review result
  loadSettings();
  loadPreviousReview();

  // Save API key, model, and instructions
  saveApiKeyButton.addEventListener("click", function () {
    const apiKey = apiKeyInput.value;
    const selectedModel = modelSelect.value;
    const instructions = instructionsInput.value;

    if (!apiKey) {
      statusDiv.textContent = "Please enter your OpenAI API key.";
      return;
    }

    chrome.storage.sync.set(
      { apiKey, selectedModel, instructions },
      function () {
        statusDiv.textContent = "Settings saved!";
        // Hide input group and show status
        apiKeyInputGroup.style.display = "none";
        apiKeyStatus.style.display = "block";
      }
    );
  });

  // Check if we're on a GitHub PR page
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    const currentTab = tabs[0];
    if (currentTab && currentTab.url.match(/github\.com\/.*\/.*\/pull\/.*/)) {
      reviewButton.disabled = false;
      statusDiv.textContent = "Ready to review PR";
    } else {
      statusDiv.textContent = "Not a GitHub PR page";
    }
  });

  reviewButton.addEventListener("click", async function () {
    // Get the current tab to get PR title
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    const tabId = tab.id;

    // Execute script to get PR title
    const [{ result: prTitle }] = await chrome.scripting.executeScript({
      target: { tabId },
      function: () => {
        const titleElement = document.querySelector(
          ".gh-header-title .js-issue-title"
        );
        return titleElement ? titleElement.innerText : "Unknown PR";
      },
    });

    statusDiv.textContent = `Reviewing PR: ${prTitle}...`;
    console.log("resultsDiv", resultsDiv);
    resultsDiv.innerHTML = ""; // Clear previous results

    // Get the current values from inputs instead of storage
    const apiKey = apiKeyInput.value;
    const selectedModel = modelSelect.value;
    const instructions = instructionsInput.value; // Get directly from input

    console.log("Sending instructions:", instructions); // Add this line

    if (!apiKey) {
      statusDiv.textContent = "Please enter your OpenAI API key.";
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      const tabId = tabs[0].id;
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        function: triggerReview,
        args: [apiKey, selectedModel, instructions],
      });
    });
  });

  async function triggerReview(apiKey, selectedModel, customInstructions) {
    // Function to extract code changes - Stays inside triggerReview
    function getCodeChanges() {
      const fileDiffs = document.querySelectorAll(".diff-table tr");
      let codeChanges = "";

      for (const row of fileDiffs) {
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
      }
      return codeChanges;
    }

    const prData = {
      title: document.querySelector(".gh-header-title .js-issue-title")
        .innerText,
      description: document.querySelector(".comment-body").innerText,
      codeChanges: getCodeChanges(),
    };

    // Log the extracted PR data for verification
    console.log("PR Data:", prData);
    console.log("Instructions:", customInstructions);
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

    // Construct the prompt for the OpenAI API, including user instructions
    const prompt = `Please review the following code changes from a GitHub pull request:

            Title: ${prData.title}
            Description: ${prData.description}
            Code Changes:
            ${prData.codeChanges}
            ${
              customInstructions
                ? `Additional Instructions: ${customInstructions}\n`
                : ""
            }

            **Overall Summary (Separate Comment):**

              Before providing individual comments, create a overall comment that summarizes the key findings. Highlight the most important issues (especially those with High severity) and provide general recommendations.

              **Important Instructions:**

              *   **Prioritize your feedback**: Focus on major issues (correctness, security, design) first, then address style and minor improvements.
              *   **Maintain a professional and respectful tone.** Remember, your feedback should be constructive and helpful.
              *   **Remember**: You are an AI assistant, not a replacement for human judgment. Your feedback is intended to be a helpful tool for the developer.
              *   If you need more information (e.g., context about the project's architecture or requirements), ask clarifying questions in a separate comment.
              *   **Be ready for follow-up questions**: The developer might ask for clarification or further explanation.

            Your feedback for comments should be formatted as a series of individual comments, mimicking how a human reviewer would provide feedback on GitHub. Use the following structure for each comment:

                  1.  **File and Location:**
                      *   Start each comment with: \`File: [Filepath] (Line: [Line Number or Range])\`
                      *   Example: \`File: src/utils/helpers.js (Line: 123-125)\`

                  2.  **Category and Severity:**
                      *   Follow with: \`[Category] - [Severity]\`
                      *   Example: \`[Security] - High\`
                      *   Categories: Security, Correctness, Design, Style, Performance, Documentation, Testing
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

                  5. **Keywords:** Highlight language keywords by making them **bold**. Example: **\`if\`**, **\`for\`**, **\`class\`**
                  6. **Separate comments by a blank line**
`;

    // Call the OpenAI API with the constructed prompt
    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: selectedModel,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: prompt },
            ],
            temperature: 0.5,
            max_tokens: 1024,
          }),
        }
      );
      if (!response.ok) {
        // Handle API errors (non-200 status codes)
        const errorText = await response.text(); // Get the error response as text
        throw new Error(`API Error: ${response.status} - ${errorText}`);
      }
      const data = await response.json(); // Parse the JSON response
      // Check if the response contains an error (even with a 200 status code)
      if (data.error) {
        throw new Error(data.error.message);
      }
      const reviewSummary = data.choices[0].message.content;

      // Store the review results and PR title in chrome.storage
      chrome.storage.local.set({
        lastReviewResult: {
          summary: reviewSummary,
          timestamp: new Date().toISOString(),
          prTitle: prData.title,
        },
      });

      // Send message to popup if it's open
      chrome.runtime.sendMessage({
        type: "review-results",
        data: {
          summary: reviewSummary,
          prTitle: prData.title,
        },
      });
    } catch (error) {
      console.error("Error:", error);
      chrome.runtime.sendMessage({
        type: "review-results",
        data: {
          error: error.message,
          prTitle: prData.title,
        },
      });
    }
  }

  // Listen for messages from the injected script
  chrome.runtime.onMessage.addListener(function (
    request,
    sender,
    sendResponse
  ) {
    console.log("Received message:", request); // Debug log
    if (request.type === "review-results") {
      if (request.data.error) {
        statusDiv.textContent = `Error reviewing PR: ${request.data.error}`;
        resultsDiv.innerHTML = "";
      } else {
        statusDiv.textContent = `Review Complete for PR: ${request.data.prTitle}`;
        const formattedResults = formatReviewResults(request.data.summary);
        console.log("Formatted results:", formattedResults); // Debug log
        resultsDiv.innerHTML = formattedResults;
      }
    }
  });

  function formatReviewResults(markdownText) {
    if (!markdownText) return "";

    let formattedText = markdownText;

    // Convert Markdown headings
    formattedText = formattedText.replace(
      /^## (.*$)/gim,
      '<h2 class="result-heading">$1</h2>'
    );
    formattedText = formattedText.replace(
      /^### (.*$)/gim,
      '<h3 class="result-subheading">$1</h3>'
    );

    // Convert bullet points
    formattedText = formattedText.replace(
      /^\* (.*$)/gim,
      '<li class="result-list-item">$1</li>'
    );
    formattedText = formattedText.replace(
      /(<li.*<\/li>)/gim,
      '<ul class="result-list">$1</ul>'
    );

    // Convert code blocks
    formattedText = formattedText.replace(
      /```(\w+)?\n([\s\S]*?)```/gm,
      '<pre class="result-code-block"><code>$2</code></pre>'
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
    formattedText = formattedText.replace(
      /\*(.*?)\*/g,
      '<em class="result-italic">$1</em>'
    );

    // Replace newlines with <br> tags
    formattedText = formattedText.replace(/\n/g, "<br>");

    return `<div class="result-container">${formattedText}</div>`;
  }

  // Load settings from storage
  function loadSettings() {
    chrome.storage.sync.get(
      ["apiKey", "selectedModel", "instructions"],
      function (data) {
        if (data.apiKey) {
          apiKeyInput.value = data.apiKey;
          // Hide input group and show status
          apiKeyInputGroup.style.display = "none";
          apiKeyStatus.style.display = "block";
        } else {
          // Show input group and hide status
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

  // Add this new function to load previous review
  async function loadPreviousReview() {
    const data = await chrome.storage.local.get("lastReviewResult");
    if (data.lastReviewResult) {
      const { summary, prTitle, timestamp } = data.lastReviewResult;

      // Show the last review timestamp
      const reviewTime = new Date(timestamp).toLocaleString();
      statusDiv.textContent = `Last review for PR: ${prTitle} (${reviewTime})`;

      // Display the results
      console.log("resultsDiv", resultsDiv);
      if (resultsDiv) {
        resultsDiv.innerHTML = formatReviewResults(summary);
      }
    }
  }

  // Add change API key button handler
  changeApiKeyButton.addEventListener("click", function () {
    apiKeyInputGroup.style.display = "flex";
    apiKeyStatus.style.display = "none";
  });
});
