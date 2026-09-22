// Shared file-browser picker: opens the chrome-less browser (/browser/dir_embed/) in a modal
let lastBrowserPath = "/browser/dir_embed/";

function openFileBrowser(fieldId) {
    const frame = document.getElementById("fileBrowserFrame");
    if (!frame) return;
    frame.dataset.fieldId = fieldId;
    if (frame.getAttribute("src") !== lastBrowserPath) {
        frame.setAttribute("src", lastBrowserPath);
    }
    $("#fileBrowserModal").modal("show");
}

document.addEventListener("click", function (event) {
    const btn = event.target.closest(".browse-btn");
    if (!btn) return;
    const fieldId = btn.getAttribute("data-target");
    if (fieldId) openFileBrowser(fieldId);
});

window.addEventListener("message", function (event) {
    const { fieldId, selectedPath, fileName, nextBrowserPath } = event.data;
    if (!fieldId || !selectedPath) return;

    if (nextBrowserPath) lastBrowserPath = nextBrowserPath;

    const input = document.getElementById(fieldId);
    if (input) {
        input.value = selectedPath;
        input.dispatchEvent(new Event("input", { bubbles: true }));

        const display = document.getElementById(fieldId + "-display");
        if (display) display.value = fileName || selectedPath;
    }

    if (input && input.dataset.stepIndex !== undefined && input.dataset.fieldName) {
        const stepIndex = parseInt(input.dataset.stepIndex, 10);
        const fieldName = input.dataset.fieldName;
        if (!Number.isNaN(stepIndex) && typeof workflow !== 'undefined' && workflow.steps[stepIndex]) {
            workflow.steps[stepIndex].extras[fieldName] = selectedPath;
        }
    }

    const label = document.getElementById("selected-name-" + fieldId);
    if (label) label.textContent = `Selected: ${fileName || selectedPath}`;

    $("#fileBrowserModal").modal("hide");
});
