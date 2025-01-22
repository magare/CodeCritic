document.addEventListener("DOMContentLoaded", function () {
  const apiKeyInput = document.getElementById("api-key");
  const saveApiKeyButton = document.getElementById("save-api-key");
  const modelSelect = document.getElementById("model-select");
  const instructionsInput = document.getElementById("instructions");
  const reviewButton = document.getElementById("review-button");
  const statusDiv = document.getElementById("status");
  const resultsDiv = document.getElementById("results");

  // Load saved settings and previous review result
  loadSettings();
  loadPreviousReview();

  // Save API key, model, and instructions
  saveApiKeyButton.addEventListener("click", function () {
    const apiKey = apiKeyInput.value;
    const selectedModel = modelSelect.value;
    const instructions = instructionsInput.value;
    chrome.storage.sync.set(
      { apiKey, selectedModel, instructions },
      function () {
        statusDiv.textContent = "Settings saved!";
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

    // Construct the prompt for the OpenAI API, including user instructions
    const prompt = `Please review the following GitHub Pull Request and provide feedback in Markdown format:

Title: ${prData.title}
Description: ${prData.description}
Code Changes:
${prData.codeChanges}
${customInstructions ? `Additional Instructions: ${customInstructions}\n` : ""}
Provide the review in the following format:
## Summary:
[A brief overview of the pull request]
## Key Changes:
[A numbered list of the significant changes]
## Potential Issues:
[Any concerns, bugs, or areas for improvement]
## Recommendations:
[Suggestions for the author]
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
            messages: [{ role: "user", content: prompt }],
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
    if (request.type === "review-results") {
      if (request.data.error) {
        statusDiv.textContent = `Error reviewing PR: ${request.data.prTitle} - ${request.data.error}`;
        resultsDiv.innerHTML = "";

        // Store the error state
        chrome.storage.local.set({
          lastReviewResult: {
            error: request.data.error,
            prTitle: request.data.prTitle,
            timestamp: new Date().toISOString(),
          },
        });
      } else {
        statusDiv.textContent = `Review Complete for PR: ${request.data.prTitle}`;
        resultsDiv.innerHTML = formatReviewResults(request.data.summary);

        // Store the successful result
        chrome.storage.local.set({
          lastReviewResult: {
            summary: request.data.summary,
            prTitle: request.data.prTitle,
            timestamp: new Date().toISOString(),
          },
        });
      }
    }
  });

  function formatReviewResults(markdownText) {
    // Convert Markdown headings to <h2> and <h3> with appropriate classes
    markdownText = markdownText.replace(
      /^## (.*$)/gim,
      '<h2 class="result-heading">$1</h2>'
    );
    markdownText = markdownText.replace(
      /^### (.*$)/gim,
      '<h3 class="result-subheading">$1</h3>'
    );

    // Convert numbered lists to <ol> and <li>, adding a class to the list
    markdownText = markdownText.replace(
      /^\d+\. (.*$)/gim,
      '<li class="result-list-item">$1</li>'
    );
    markdownText = markdownText.replace(
      /(<li>.*<\/li>)/gim,
      '<ol class="result-list">$1</ol>'
    );

    // Convert bold patterns to <strong> tags
    markdownText = markdownText.replace(
      /\*\*(.*?)\*\*/g,
      '<strong class="result-bold">$1</strong>'
    );

    // Convert code block patterns to <pre><code>, adding a class to the <pre> element
    markdownText = markdownText.replace(
      /`(.*?)`/gs,
      '<pre class="result-code-block"><code>$1</code></pre>'
    );

    // Replace newlines with <br> tags
    markdownText = markdownText.replace(/\n/g, "<br>");

    // Wrap the entire result in a <div> with a class for styling
    return `<div class="result-item">${markdownText}</div>`;
  }

  // Load settings from storage
  function loadSettings() {
    chrome.storage.sync.get(
      ["apiKey", "selectedModel", "instructions"],
      function (data) {
        if (data.apiKey) {
          apiKeyInput.value = data.apiKey;
        }
        if (data.selectedModel) {
          modelSelect.value = data.selectedModel;
        }
        if (data.instructions) {
          instructionsInput.value = data.instructions;
          console.log("Loaded instructions:", data.instructions);
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
      resultsDiv.innerHTML = formatReviewResults(summary);
    }
  }
});
