const API_URL = 'http://127.0.0.1:8000/extract';
const REQUEST_TIMEOUT_MS = 90000;
let currentExtraction = null;
let lastUploadedFile = null;

function setStatus(message) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.classList.remove('error', 'success');
}

function setStatusKind(kind) {
    const status = document.getElementById('status');
    status.classList.remove('error', 'success');
    if (kind) {
        status.classList.add(kind);
    }
}

function setModeBadge(mode) {
    const badge = document.getElementById('modeBadge');
    if (!badge) return;
    if (!mode) {
        badge.style.display = 'none';
        return;
    }

    if (mode === 'local') {
        // badge.textContent = 'Local fallback';
        badge.style.display = 'inline-block';
    } else if (mode === 'ai') {
        // badge.textContent = 'AI mapping';
        badge.style.display = 'inline-block';
    } else {
        badge.textContent = mode;
        badge.style.display = 'inline-block';
    }
}

function capturePageScreenshot() {
    return new Promise((resolve, reject) => {
        chrome.tabs.captureVisibleTab({ format: 'png' }, dataUrl => {
            if (chrome.runtime.lastError || !dataUrl) {
                reject(new Error(chrome.runtime.lastError?.message || 'Failed to capture screenshot.'));
                return;
            }
            resolve(dataUrl);
        });
    });
}

function dataURLToBlob(dataUrl) {
    const [header, data] = dataUrl.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const binary = atob(data);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        array[i] = binary.charCodeAt(i);
    }
    return new Blob([array], { type: mime });
}

function setBusy(isBusy) {
    document.getElementById('uploadBtn').disabled = isBusy;
    document.getElementById('clearBtn').disabled = isBusy;
    document.getElementById('progress').classList.toggle('active', isBusy);
}

function setMetric(id, value) {
    document.getElementById(id).textContent = value;
}

function resetMetrics() {
    setMetric('extractedMetric', 0);
    setMetric('filledMetric', 0);
}

function resetResults() {
    const resultList = document.getElementById('resultList');
    resultList.innerHTML = '';
    resultList.classList.remove('visible');
}

function updateFileName() {
    const fileInput = document.getElementById('fileInput');
    const fileName = document.getElementById('fileName');
    if (fileInput.files.length === 0) {
        fileName.textContent = 'Images, PDF, TXT, DOCX, XLSX, PPTX';
    } else if (fileInput.files.length === 1) {
        fileName.textContent = fileInput.files[0].name;
    } else {
        fileName.textContent = `${fileInput.files.length} files selected`;
    }
}

// function renderResults(data, fields = {}) {
//     const resultList = document.getElementById('resultList');
//     const entries = Object.entries(data || {});

//     resultList.innerHTML = entries.slice(0, 12).map(([key, value]) => {
//         const label = fields[key]?.source || key;
//         const origin = fields[key]?.origin || '';
//         return `
//             <div class="field-row" data-key="${escapeHtml(key)}">
//                 <span class="field-key">${escapeHtml(label.replace(/_/g, ' '))}</span>
//                 <span class="field-value">${escapeHtml(value)}</span>
//                 <span class="field-origin" style="display:block; font-size:11px; color:#6b7280;">${escapeHtml(origin)}</span>
//             </div>
//         `;
//     }).join('');

//     resultList.classList.toggle('visible', entries.length > 0);
// }

function renderResults(data) {
    const resultList = document.getElementById('resultList');
    const entries = Object.entries(data || {});

    resultList.innerHTML = entries.map(([key, value]) => `
        <div class="field-row">
            <div class="field-key">${escapeHtml(key)}</div>
            <div class="field-value">${escapeHtml(value)}</div>
        </div>
    `).join('');

    resultList.classList.toggle('visible', entries.length > 0);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[character]));
}

function executeContentScript(tabId) {
    return new Promise(resolve => {
        chrome.scripting.executeScript(
            {
                target: { tabId, allFrames: true },
                files: ['content.js'],
            },
            () => {
                if (chrome.runtime.lastError) {
                    resolve({ ok: false, error: chrome.runtime.lastError.message });
                    return;
                }
                resolve({ ok: true });
            }
        );
    });
}

function getActiveTab() {
    return new Promise((resolve, reject) => {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (!tabs || !tabs[0] || !tabs[0].id) {
                reject(new Error('No active tab found.'));
                return;
            }
            resolve(tabs[0]);
        });
    });
}

function getFrames(tabId) {
    return new Promise(resolve => {
        if (!chrome.webNavigation || !chrome.webNavigation.getAllFrames) {
            resolve([{ frameId: 0 }]);
            return;
        }

        chrome.webNavigation.getAllFrames({ tabId }, frames => {
            if (chrome.runtime.lastError || !frames || !frames.length) {
                resolve([{ frameId: 0 }]);
                return;
            }
            resolve(frames);
        });
    });
}

function sendMessageToFrame(tabId, frameId, payload) {
    return new Promise(resolve => {
        chrome.tabs.sendMessage(tabId, payload, { frameId }, response => {
            if (chrome.runtime.lastError) {
                resolve({ filled: 0, controls: 0, candidates: 0, error: chrome.runtime.lastError.message });
                return;
            }
            resolve(response || { filled: 0, controls: 0, candidates: 0 });
        });
    });
}

async function sendFillMessage(tabId, payload) {
    setStatus('Preparing page...');
    const injection = await executeContentScript(tabId);
    if (!injection.ok) {
        throw new Error(injection.error || 'Could not access this page.');
    }

    setStatus('Finding frames...');
    const frames = await getFrames(tabId);

    setStatus(`Filling ${frames.length} frame(s)...`);
    const results = await Promise.all(frames.map(frame => sendMessageToFrame(tabId, frame.frameId, payload)));

    return results.reduce((summary, result) => ({
        filled: summary.filled + (result.filled || 0),
        controls: summary.controls + (result.controls || 0),
        candidates: Math.max(summary.candidates, result.candidates || 0),
        errors: summary.errors + (result.error ? 1 : 0),
    }), { filled: 0, controls: 0, candidates: 0, errors: 0 });
}

async function extractDocument(file, screenshotDataUrl = null) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const formData = new FormData();

    formData.append('file', file);
    if (screenshotDataUrl) {
        const screenshotBlob = dataURLToBlob(screenshotDataUrl);
        formData.append('page_screenshot', screenshotBlob, 'page_screenshot.png');
    }

    try {
        const response = await fetch(API_URL, { method: 'POST', body: formData, signal: controller.signal });
        const text = await response.text();

        let result;
        try {
            result = JSON.parse(text);
        } catch (error) {
            throw new Error(`Backend returned non-JSON response: ${text.slice(0, 120)}`);
        }

        if (!response.ok) {
            throw new Error(result.detail || 'OCR extraction failed');
        }

        return result;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function handleExtract() {
    const fileInput = document.getElementById('fileInput');
    const file = fileInput.files[0];

    // remember the uploaded file so we can send it to the mapping endpoint
    lastUploadedFile = file;

    if (!file) {
        setStatus('Choose a file first.');
        setStatusKind('error');
        return;
    }

    setBusy(true);
    resetMetrics();
    resetResults();
    currentExtraction = null;

    try {
        setStatus('Extracting...');

        // Start screenshot capture and document extraction in parallel.
        const screenshotPromise = capturePageScreenshot().catch(err => {
            console.warn('Screenshot failed:', err);
            return null;
        });

        const extractPromise = extractDocument(file, null).catch(err => {
            throw err;
        });

        // Await extraction result (document). We'll merge page context later if screenshot resolves.
        const result = await extractPromise;
        currentExtraction = result;
        const dataCount = Object.keys(result.data || {}).length;
        // show extracted fields and update metric
        setMetric('extractedMetric', dataCount);
        renderResults(result.data, result.fields);
        if (!dataCount) {
            setStatus('No structured fields were extracted.');
            setStatusKind('error');
            // still attempt to merge page context in background
        } else {
            // wait for screenshot and merge page context before filling
            const screenshotDataUrl = await screenshotPromise;
            if (screenshotDataUrl) {
                setStatus('Uploading page screenshot to derive page context...');
                try {
                    const pageCtxForm = new FormData();
                    const blob = dataURLToBlob(screenshotDataUrl);
                    pageCtxForm.append('page_screenshot', blob, 'page_screenshot.png');

                    const resp = await fetch('http://127.0.0.1:8000/page_context', { method: 'POST', body: pageCtxForm });
                    const text = await resp.text();
                    let pageResp;
                    try {
                        pageResp = JSON.parse(text);
                    } catch (e) {
                        console.warn('Non-JSON page context response', text.slice(0, 200));
                    }

                    if (resp.ok && pageResp && pageResp.page_context) {
                        currentExtraction.page_context = pageResp.page_context;
                        setStatus('Page context merged. Filling page...');
                    } else {
                        console.warn('Page context API error', pageResp?.detail || pageResp);
                        setStatus('Extraction successful. Filling page with document-only context...');
                    }
                } catch (err) {
                    console.error('Page context upload failed', err);
                    setStatus('Extraction successful. Filling page with document-only context...');
                }
            } else {
                setStatus('Screenshot unavailable; filling with document-only context...');
            }

            setStatusKind('success');
            // automatically trigger fill after merging (or fallback)
            await handleFill(screenshotDataUrl);
        }
    } catch (error) {
        console.error(error);
        setStatus(error.message || 'Extraction failed.');
        setStatusKind('error');
    } finally {
        setBusy(false);
    }
}

async function handleFill(passedScreenshotDataUrl = null) {
    if (!currentExtraction || !currentExtraction.data || !Object.keys(currentExtraction.data).length) {
        setStatus('Run extraction first before filling the page.');
        setStatusKind('error');
        return;
    }

    setBusy(true);
    setStatus('Analyzing page (DOM + screenshot) for intelligent mapping...');

    try {
        const tab = await getActiveTab();
        const injection = await executeContentScript(tab.id);
        if (!injection.ok) throw new Error(injection.error || 'Could not access this page.');

            // Gather DOM from all frames in parallel
            const frames = await getFrames(tab.id);
            const domResponses = await Promise.all(frames.map(f => sendMessageToFrame(tab.id, f.frameId, { type: 'GATHER_DOM' })));

        // Merge DOM controls
        const domControls = domResponses.reduce((acc, resp) => {
            if (resp && Array.isArray(resp.controls)) acc.push(...resp.controls);
            return acc;
        }, []);

        // Use passed screenshot when available (captured during extraction), otherwise capture now
        let screenshotDataUrl = passedScreenshotDataUrl;
        if (!screenshotDataUrl) {
            try {
                screenshotDataUrl = await capturePageScreenshot();
            } catch (err) {
                console.warn('Screenshot for mapping failed:', err);
                screenshotDataUrl = null;
            }
        }

        // Call backend /map_fields
        setStatus('Requesting mapping...');
        const form = new FormData();
        form.append('data', JSON.stringify(currentExtraction.data));
        form.append('dom', JSON.stringify(domControls));
        form.append('fields', JSON.stringify(currentExtraction.fields || {}));
        // include the original uploaded document (image/PDF) so the AI can reason over it
        if (lastUploadedFile) {
            try {
                form.append('source_file', lastUploadedFile, lastUploadedFile.name);
            } catch (e) {
                console.warn('Could not attach original file to mapping request', e);
            }
        }
        // include any extracted/raw text the extractor returned to help mapping
        const extractedText = currentExtraction.text || currentExtraction.raw_text || currentExtraction.full_text || currentExtraction.fullText || '';
        if (extractedText) {
            try {
                form.append('extracted_text', typeof extractedText === 'string' ? extractedText : JSON.stringify(extractedText));
            } catch (e) {
                console.warn('Could not attach extracted text to mapping request', e);
            }
        }
        if (screenshotDataUrl) {
            form.append('page_screenshot', dataURLToBlob(screenshotDataUrl), 'page_screenshot.png');
        }

        const mapResp = await fetch('http://127.0.0.1:8000/map_fields', { method: 'POST', body: form });
        const mapText = await mapResp.text();
        let mapJson;
        try {
            mapJson = JSON.parse(mapText);
        } catch (err) {
            // If backend returns non-JSON, fall back to local heuristics
            console.warn('Invalid map_fields response, falling back to local mapping', mapText.slice(0, 200));
            mapJson = null;
        }

        // Determine whether AI mapping succeeded
        let useLocalFallback = false;
        if (!mapResp.ok) {
            useLocalFallback = true;
        }
        if (mapJson && mapJson.mapping_method === 'local') {
            useLocalFallback = true;
        }
        if (mapJson && (Array.isArray(mapJson.mappings) && mapJson.mappings.length === 0)) {
            // No mappings returned -> fallback
            useLocalFallback = true;
        }
        if (mapJson && Array.isArray(mapJson.mappings) && mapJson.mappings.every(item => !item || !item.selector)) {
            useLocalFallback = true;
        }
        if (mapJson && mapJson.error && /credit|quota|quota_exceeded|insufficient|401|402/i.test(String(mapJson.error))) {
            useLocalFallback = true;
        }

        if (useLocalFallback) {
            setStatus('AI mapping unavailable; using local heuristics to fill the page...');
            setModeBadge('local');
        } else {
            setStatus('Applying AI mapping to page...');
            setModeBadge('ai');
        }

        // Send mapping + data to content script to perform targeted fill
        const fillPayload = {
            type: 'FILL_FORM',
            data: currentExtraction.data,
            fields: currentExtraction.fields,
            page_context: currentExtraction.page_context,
            mapping: mapJson && Array.isArray(mapJson.mappings) ? mapJson.mappings : [],
        };

        const fillResult = await sendFillMessage(tab.id, fillPayload);
  
        setMetric('filledMetric', fillResult.filled);
        // If content script returned per-field info, annotate results
        if (fillResult.filledItems && Array.isArray(fillResult.filledItems)) {
            // build a quick map of origin per key
            const originMap = {};
            fillResult.filledItems.forEach(item => {
                originMap[item.key] = item.method === 'ai' ? 'Filled by AI' : 'Filled by local heuristics';
            });

            // update result list DOM entries
            const resultList = document.getElementById('resultList');
            if (resultList) {
                fillResult.filledItems.forEach(item => {
                    const row = resultList.querySelector(`[data-key="${CSS.escape(item.key)}"]`);
                    if (row) {
                        const originEl = row.querySelector('.field-origin');
                        if (originEl) originEl.textContent = originMap[item.key];
                    }
                });
            }
        }

        if (fillResult.filled > 0) {
            setStatus(`Filled ${fillResult.filled} field(s). Review the page once and submit manually, I may not be accurate.`);
            setStatusKind('success');
        } else {
            setStatus('No fields were filled. AI mapping may have failed; try manual review.');
            setStatusKind('error');
        }
    } catch (error) {
        console.error(error);
        setStatus(error.message || 'Fill failed.');
        setStatusKind('error');
    } finally {
        setBusy(false);
    }
}


function handleClear() {
    document.getElementById('fileInput').value = '';
    updateFileName();
    resetMetrics();
    resetResults();
    setStatus('Ready.');
    setStatusKind('');
    currentExtraction = null;
    lastUploadedFile = null;
    setModeBadge(null);
}

window.addEventListener('DOMContentLoaded', () => {
    document.getElementById('uploadBtn').addEventListener('click', handleExtract);
    document.getElementById('clearBtn').addEventListener('click', handleClear);
    document.getElementById('fileInput').addEventListener('change', updateFileName);
    updateFileName();
});
