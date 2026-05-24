(() => {
    if (globalThis.__AI_AUTOFILL_ASSISTANT_LOADED__) {
        return;
    }
    globalThis.__AI_AUTOFILL_ASSISTANT_LOADED__ = true;

    const CONTROL_SELECTOR = [
        'input:not([type="hidden"]):not([disabled])',
        'textarea:not([disabled])',
        'select:not([disabled])',
        '[contenteditable="true"]',
        '[role="textbox"]',
        '[role="combobox"]',
        '[role="radio"]',
        '[role="checkbox"]'
    ].join(',');

    function normalize(value) {
        return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    }

    function keyToLabel(key) {
        return String(key || '').replace(/_/g, ' ');
    }

    const FIELD_KEY_ALIASES = {
        student_id: ['student id', 'student identity', 'roll number', 'roll no', 'registration number', 'admission number', 'enrollment number', 'application number'],
        branch: ['branch', 'department', 'course', 'programme', 'program', 'stream', 'academic branch', 'course / branch'],
        father_name: ['father name', "father's name", 'father full name', 'parent name', "parent's name"],
        address: ['address', 'residential address', 'permanent address', 'current address', 'mailing address'],
        date_of_birth: ['date of birth', 'dob', 'birth date', 'birthday'],
        name: ['name', 'full name', 'student name', 'applicant name', 'candidate name'],
        phone: ['phone', 'mobile', 'mobile number', 'phone number', 'contact number', 'cell'],
    };

    function words(value) {
        return normalize(value).split(' ').filter(Boolean);
    }

    function tokenOverlap(left, right) {
        const leftWords = new Set(words(left));
        const rightWords = new Set(words(right));

        if (!leftWords.size || !rightWords.size) {
            return 0;
        }

        let overlap = 0;
        rightWords.forEach(word => {
            if (leftWords.has(word)) {
                overlap++;
            }
        });

        return overlap / rightWords.size;
    }

    function levenshtein(left, right) {
        const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

        for (let i = 1; i <= left.length; i++) {
            const current = [i];

            for (let j = 1; j <= right.length; j++) {
                current[j] = Math.min(
                    current[j - 1] + 1,
                    previous[j] + 1,
                    previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
                );
            }

            previous.splice(0, previous.length, ...current);
        }

        return previous[right.length];
    }

    function similarity(left, right) {
        const cleanLeft = normalize(left);
        const cleanRight = normalize(right);

        if (!cleanLeft || !cleanRight) {
            return 0;
        }

        if (cleanLeft.includes(cleanRight) || cleanRight.includes(cleanLeft)) {
            return 1;
        }

        const distance = levenshtein(cleanLeft, cleanRight);
        const editScore = 1 - distance / Math.max(cleanLeft.length, cleanRight.length, 1);
        return Math.max(editScore, tokenOverlap(cleanLeft, cleanRight));
    }

    function textByIds(ids) {
        return String(ids || '')
            .split(/\s+/)
            .map(id => document.getElementById(id))
            .filter(Boolean)
            .map(element => element.textContent)
            .join(' ');
    }

    function nearestQuestionText(control) {
        const containers = [
            control.closest('[role="listitem"]'),
            control.closest('[data-params]'),
            control.closest('.freebirdFormviewerViewItemsItemItem'),
            control.closest('.Qr7Oae'),
            control.closest('fieldset'),
            control.closest('label'),
            control.parentElement
        ].filter(Boolean);

        return containers
            .map(container => container.textContent)
            .filter(Boolean)
            .sort((a, b) => a.length - b.length)
            .slice(0, 2)
            .join(' ');
    }

    function getFieldText(control) {
        const label = control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`) : null;
        const parentLabel = control.closest('label');

        return [
            control.name,
            control.id,
            control.placeholder,
            control.value,
            control.getAttribute('aria-label'),
            control.getAttribute('data-value'),
            textByIds(control.getAttribute('aria-labelledby')),
            textByIds(control.getAttribute('aria-describedby')),
            label && label.textContent,
            parentLabel && parentLabel.textContent,
            nearestQuestionText(control)
        ].filter(Boolean).join(' ');
    }

    function queryAllDeep(root, selector) {
        const results = [];

        if (root.querySelectorAll) {
            results.push(...root.querySelectorAll(selector));
            root.querySelectorAll('*').forEach(element => {
                if (element.shadowRoot) {
                    results.push(...queryAllDeep(element.shadowRoot, selector));
                }
            });
        }

        return results;
    }

    function buildCandidateLabels(key, sourceLabel, pageLabels = [], pageFieldLabels = {}, aiPageFieldLabels = {}) {
        const labels = [key, keyToLabel(key), sourceLabel].filter(Boolean);
        const normalizedKey = normalize(key);
        const normalizedSource = normalize(sourceLabel || '');

        if (!normalizedKey.includes(' ')) {
            labels.push(normalizedKey.replace(/_/g, ' '));
        }

        if (sourceLabel) {
            labels.push(normalize(sourceLabel));
        }

        if (normalizedKey.includes('dob')) {
            labels.push('date of birth', 'birth date', 'dob');
        }

        if (Array.isArray(pageLabels)) {
            pageLabels.forEach(pageLabel => {
                const normalizedPageLabel = normalize(pageLabel);
                if (!normalizedPageLabel) {
                    return;
                }

                const directMatch = normalizedPageLabel.includes(normalizedKey) || (normalizedSource && normalizedPageLabel.includes(normalizedSource));
                const keySimilarity = normalizedKey ? similarity(normalizedPageLabel, normalizedKey) : 0;
                const sourceSimilarity = normalizedSource ? similarity(normalizedPageLabel, normalizedSource) : 0;

                if (directMatch || keySimilarity >= 0.65 || sourceSimilarity >= 0.75) {
                    labels.push(pageLabel);
                }
            });
        }

        if (FIELD_KEY_ALIASES[key]) {
            FIELD_KEY_ALIASES[key].forEach(alias => labels.push(alias));
        }

        if (Array.isArray(pageFieldLabels[key])) {
            pageFieldLabels[key].forEach(label => {
                if (label) {
                    labels.push(label);
                }
            });
        }

        if (Array.isArray(aiPageFieldLabels[key])) {
            aiPageFieldLabels[key].forEach(label => {
                if (label) {
                    labels.push(label);
                }
            });
        }

        return uniqueValues(labels);
    }

    function extractedFieldCandidates(message) {
        const data = message.data || {};
        const fieldDetails = message.fields || {};
        const pageLabels = Array.isArray(message.page_context?.hint_labels) ? message.page_context.hint_labels : [];
        const pageFieldLabels = message.page_context?.field_label_map || {};
        const aiPageFieldLabels = message.page_context?.ai_field_label_map || {};
        const candidates = [];

        Object.entries(data).forEach(([key, value]) => {
            const detail = fieldDetails[key] || {};
            const source = detail.source || '';
            const sourceLabel = source === 'gemini-vision' ? '' : source;

            candidates.push({
                key,
                labels: buildCandidateLabels(key, sourceLabel, pageLabels, pageFieldLabels, aiPageFieldLabels),
                value
            });
        });

        return candidates;
    }

    function getExactControlText(control) {
        return normalize([control.name, control.id, control.placeholder, control.getAttribute('aria-label'), control.getAttribute('data-value')].filter(Boolean).join(' '));
    }

    function getControlContext(control) {
        return normalize([
            getFieldText(control),
            getExactControlText(control),
            nearestQuestionText(control)
        ].filter(Boolean).join(' '));
    }

    function getElementXPath(element) {
        if (element === document.body) return '/html/body';
        const parts = [];
        while (element && element.nodeType === Node.ELEMENT_NODE) {
            let nb = 0;
            let sib = element.previousSibling;
            while (sib) {
                if (sib.nodeType === Node.ELEMENT_NODE && sib.nodeName === element.nodeName) nb++;
                sib = sib.previousSibling;
            }
            const tagName = element.nodeName.toLowerCase();
            const index = nb + 1;
            parts.unshift(`${tagName}[${index}]`);
            element = element.parentNode;
        }
        return '/' + parts.join('/');
    }

    function gatherDomSnapshot() {
        const controls = queryAllDeep(document, CONTROL_SELECTOR);
        return controls.map(control => ({
            id: control.id || null,
            name: control.name || null,
            tagName: control.tagName || null,
            type: (control.type || null),
            placeholder: control.placeholder || null,
            ariaLabel: control.getAttribute('aria-label') || null,
            ariaLabelledBy: control.getAttribute('aria-labelledby') || null,
            labelText: (control.id ? (document.querySelector(`label[for="${CSS.escape(control.id)}"]`)?.textContent || null) : null) || (control.closest('label')?.textContent || null),
            nearestText: nearestQuestionText(control) || null,
            exactText: getExactControlText(control) || null,
            xpath: getElementXPath(control)
        }));
    }

    function isValuePatternCompatible(control, value) {
        const type = String(control.type || '').toLowerCase();
        const text = String(value || '').trim();

        if (type === 'email') {
            return /@/.test(text);
        }
        if (type === 'tel' || type === 'phone') {
            return /\d{7,}/.test(text);
        }
        if (type === 'date') {
            return /\d{4}-\d{2}-\d{2}/.test(text) || /\d{1,2}[-./]\d{1,2}[-./]\d{2,4}/.test(text);
        }
        return true;
    }

    function scoreCandidate(control, candidate) {
        const fieldText = getFieldText(control);
        const exactControlText = getExactControlText(control);
        const contextText = getControlContext(control);
        const candidateText = normalize(candidate.labels.join(' '));

        const labelScore = candidate.labels.reduce((max, label) => Math.max(max, similarity(fieldText, label)), 0);
        const directScore = candidate.labels.reduce((max, label) => Math.max(max, similarity(exactControlText, label)), 0);
        const contextScore = similarity(contextText, candidateText);
        const bestScore = Math.max(labelScore, directScore, contextScore);

        let bonus = 0;
        if (candidate.labels.some(label => exactControlText.includes(normalize(label)))) {
            bonus += 0.2;
        }
        if (exactControlText.includes(normalize(candidate.key))) {
            bonus += 0.15;
        }
        if (isValuePatternCompatible(control, candidate.value)) {
            bonus += 0.05;
        }
        if (contextScore > 0.70) {
            bonus += 0.1;
        }

        return Math.min(1, bestScore + bonus);
    }

    function uniqueValues(values) {
        return Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)));
    }

    function matchExtractedField(control, candidates) {
        let bestMatch = { candidate: null, score: 0 };

        candidates.forEach(candidate => {
            const score = scoreCandidate(control, candidate);
            if (score > bestMatch.score) {
                bestMatch = { candidate, score };
            }
        });

        return bestMatch.score >= 0.58 ? bestMatch.candidate : null;
    }

    function dispatchFormEvents(element) {
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
    }

    function setNativeValue(input, value) {
        input.focus();

        const prototype = Object.getPrototypeOf(input);
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

        if (descriptor && descriptor.set) {
            descriptor.set.call(input, value);
        } else {
            input.value = value;
        }

        dispatchFormEvents(input);
        input.blur();
    }

    function toDateInputValue(value) {
        const text = String(value || '').trim();
        let match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
        if (match) {
            return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
        }

        match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
        if (match) {
            return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
        }

        return text;
    }

    function setSelectValue(select, value) {
        const match = Array.from(select.options).find(option => (
            similarity(option.textContent, value) >= 0.75 ||
            similarity(option.value, value) >= 0.75
        ));

        if (!match) {
            return false;
        }

        select.value = match.value;
        dispatchFormEvents(select);
        return true;
    }

    function clickChoice(control, value) {
        const text = getFieldText(control);
        const controlValue = control.getAttribute('aria-label') || control.getAttribute('data-value') || control.value || text;

        if (similarity(controlValue, value) < 0.72 && similarity(text, value) < 0.72) {
            return false;
        }

        control.click();
        dispatchFormEvents(control);
        return true;
    }

    function setContentEditable(element, value) {
        element.focus();
        element.textContent = value;
        dispatchFormEvents(element);
        element.blur();
    }

    function fillControl(control, candidate) {
        if (!candidate || candidate.value == null || candidate.value === '') {
            return false;
        }

        const value = String(candidate.value);
        const tagName = control.tagName.toLowerCase();
        const type = String(control.type || '').toLowerCase();
        const role = control.getAttribute('role');

        if (tagName === 'select') {
            return setSelectValue(control, value);
        }

        if (type === 'radio' || type === 'checkbox' || role === 'radio' || role === 'checkbox') {
            return clickChoice(control, value);
        }

        if (control.isContentEditable || role === 'textbox') {
            setContentEditable(control, value);
            return true;
        }

        if (tagName === 'textarea' || tagName === 'input') {
            setNativeValue(control, type === 'date' ? toDateInputValue(value) : value);
            return true;
        }

        if (role === 'combobox') {
            control.click();
            setNativeValue(control, value);
            return true;
        }

        return false;
    }

    function fillPage(message) {
        const candidates = extractedFieldCandidates(message);
        const controls = queryAllDeep(document, CONTROL_SELECTOR);
        const usedKeys = new Set();
        let filled = 0;
        const filledItems = [];

        // If the backend provided an explicit mapping, apply it first
        if (Array.isArray(message.mapping)) {
            for (const map of message.mapping) {
                if (!map || !map.selector || !map.key) continue;
                const value = message.data?.[map.key];
                if (value == null || value === '') continue;

                let control = null;
                try {
                    if (map.selector.by === 'id' && map.selector.value) {
                        control = document.getElementById(map.selector.value);
                    } else if (map.selector.by === 'name' && map.selector.value) {
                        const els = document.getElementsByName(map.selector.value);
                        if (els && els.length) control = els[0];
                    } else if (map.selector.by === 'xpath' && map.selector.value) {
                        const res = document.evaluate(map.selector.value, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                        control = res && res.singleNodeValue;
                    }
                } catch (e) {
                    control = null;
                }

                if (control && !usedKeys.has(map.key)) {
                    if (fillControl(control, { key: map.key, value, labels: [map.selector.value] })) {
                        usedKeys.add(map.key);
                        filled++;
                        try {
                            filledItems.push({ key: map.key, method: 'ai', selector: `${map.selector.by}:${map.selector.value}` });
                        } catch (e) {}
                    }
                }
            }
        }

        // Fallback: run fuzzy matching for remaining fields
        const scoredControls = controls.map(control => {
            const candidate = matchExtractedField(control, candidates);
            const score = candidate ? scoreCandidate(control, candidate) : 0;
            return { control, candidate, score };
        }).filter(item => item.candidate && item.score > 0.7)
          .sort((a, b) => b.score - a.score);

        scoredControls.forEach(({ control, candidate }) => {
            if (usedKeys.has(candidate.key)) {
                return;
            }

            if (fillControl(control, candidate)) {
                usedKeys.add(candidate.key);
                filled++;
                try {
                    filledItems.push({ key: candidate.key, method: 'local', selector: getElementXPath(control) });
                } catch (e) {}
            }
        });

        return { filled, controls: controls.length, candidates: candidates.length, filledItems };
    }

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.type !== 'FILL_FORM') {
            if (message.type === 'GATHER_DOM') {
                try {
                    const snapshot = gatherDomSnapshot();
                    sendResponse({ controls: snapshot });
                } catch (err) {
                    sendResponse({ controls: [], error: String(err) });
                }
                return true;
            }
            return false;
        }

        sendResponse(fillPage(message));
        return true;
    });
})();
