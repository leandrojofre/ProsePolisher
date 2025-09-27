import { extension_settings, getContext } from "../../../extensions.js";
import { callGenericPopup, POPUP_TYPE } from "../../../popup.js";
import { MacrosParser } from "../../../macros.js";

// Import all data files
import { commonWords } from './common_words.js';
import { defaultNames } from './default_names.js';
import { lemmaMap } from './lemmas.js';

const LOG_PREFIX = `[ProsePolisher:Analyzer]`;
const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/ProsePolisher`;

// Constants
const CANDIDATE_LIMIT_FOR_ANALYSIS = 2000;
const NGRAM_MIN = 3; // The minimum n-gram size is fundamental to the logic.

// Utility Functions
function stripMarkup(text) {
    if (!text) return '';
    let cleanText = text;

    // Remove code blocks first
    cleanText = cleanText.replace(/(?:```|~~~)\w*\s*[\s\S]*?(?:```|~~~)/g, ' ');
    
    // Remove ALL HTML tags and their content, including:
    // - Paired tags with content: <tag>content</tag>
    // - Self-closing tags: <img src="..." />
    // - Tags with attributes: <div class="example">
    // This comprehensive regex handles nested tags and attributes
    cleanText = cleanText.replace(/<([^>]+)>[\s\S]*?<\/\1>/gi, ' '); // Remove paired tags with content
    cleanText = cleanText.replace(/<[^>]+\/>/g, ' '); // Remove self-closing tags
    cleanText = cleanText.replace(/<[^>]*>/g, ' '); // Remove any remaining HTML tags
    
    // Remove markdown emphasis but keep the text
    cleanText = cleanText.replace(/(?:\*|_|~|`)+(.+?)(?:\*|_|~|`)+/g, '$1');
    // Remove content in quotes and parentheses, which often cause fragments
    cleanText = cleanText.replace(/"(.*?)"/g, ' $1 ');
    cleanText = cleanText.replace(/\((.*?)\)/g, ' $1 ');
    // Collapse multiple spaces and trim
    cleanText = cleanText.replace(/\s+/g, ' ').trim();

    return cleanText;
}

function generateNgrams(words, n) {
    const ngrams = [];
    if (words.length < n) return ngrams;
    for (let i = 0; i <= words.length - n; i++) {
        ngrams.push(words.slice(i, i + n).join(' '));
    }
    return ngrams;
}

function cullSubstrings(frequenciesObject) {
    // This function removes overlapping/substring phrases to prevent duplicates
    // while keeping the highest scoring versions

    const culledFrequencies = { ...frequenciesObject };
    const sortedPhrases = Object.keys(culledFrequencies).sort((a, b) => b.length - a.length);
    const phrasesToRemove = new Set();

    // First pass: Remove exact duplicates, keeping higher scores
    const phraseMap = new Map();
    for (const [phrase, score] of Object.entries(culledFrequencies)) {
        const normalizedPhrase = phrase.toLowerCase().trim();
        if (phraseMap.has(normalizedPhrase)) {
            // Keep the one with higher score
            const existingScore = phraseMap.get(normalizedPhrase).score;
            if (score <= existingScore) {
                phrasesToRemove.add(phrase);
            } else {
                phrasesToRemove.add(phraseMap.get(normalizedPhrase).phrase);
                phraseMap.set(normalizedPhrase, { phrase, score });
            }
        } else {
            phraseMap.set(normalizedPhrase, { phrase, score });
        }
    }

    // Second pass: Remove substrings if they have significantly lower scores
    // This prevents the duplicate overlapping phrases issue
    // OPTIMIZATION: Limit to top phrases to avoid O(n²) complexity on large sets
    const maxPhrasesToCheck = Math.min(sortedPhrases.length, 500);

    for (let i = 0; i < maxPhrasesToCheck; i++) {
        const longerPhrase = sortedPhrases[i];
        if (phrasesToRemove.has(longerPhrase)) continue;

        const longerScore = culledFrequencies[longerPhrase];

        // Only check phrases that could potentially be substrings
        for (let j = i + 1; j < maxPhrasesToCheck; j++) {
            const shorterPhrase = sortedPhrases[j];
            if (phrasesToRemove.has(shorterPhrase)) continue;

            // Quick length check before expensive string operation
            if (shorterPhrase.length >= longerPhrase.length) continue;

            // Check if shorter phrase is contained in longer phrase
            if (longerPhrase.includes(shorterPhrase)) {
                const shorterScore = culledFrequencies[shorterPhrase];

                // Remove the shorter phrase if:
                // 1. The longer phrase has a higher or similar score (within 20%)
                // 2. OR the phrases overlap significantly (more than 70% of shorter phrase)
                const scoreDifference = Math.abs(longerScore - shorterScore) / Math.max(longerScore, shorterScore);
                const overlapRatio = shorterPhrase.length / longerPhrase.length;

                if (scoreDifference < 0.2 || overlapRatio > 0.7) {
                    // Keep the one with higher score
                    if (longerScore >= shorterScore) {
                        phrasesToRemove.add(shorterPhrase);
                    } else {
                        phrasesToRemove.add(longerPhrase);
                        break; // No need to check more shorter phrases for this longer one
                    }
                }
            }
        }
    }

    phrasesToRemove.forEach(phrase => {
        delete culledFrequencies[phrase];
    });
    return culledFrequencies;
}


// --- Analyzer Class ---
export class Analyzer {
    constructor(settings, callGenericPopup, POPUP_TYPE, toastr, saveSettingsDebounced) {
        this.settings = settings;
        this.callGenericPopup = callGenericPopup;
        this.POPUP_TYPE = POPUP_TYPE;
        this.toastr = toastr;
        this.saveSettingsDebounced = saveSettingsDebounced;

        this.ngramFrequencies = new Map();
        this.slopCandidates = new Set();
        this.analyzedLeaderboardData = { merged: {}, remaining: {} };
        this.messageCounterForTrigger = 0;
        this.totalAiMessagesProcessed = 0;
        this.isAnalyzingHistory = false;
        this.lastAnalysisMessageCount = 0; // Track when analysis was last performed
        this.isUpdatingMacro = false; // Flag to prevent recursive macro updates

        this.effectiveWhitelist = new Set();
        this.updateEffectiveWhitelist();
    }

    updateEffectiveWhitelist() {
        // Note: effectiveWhitelist is deprecated but kept for compatibility
        // The actual whitelist logic is now in isPhraseLowQuality
        const userWhitelist = new Set((this.settings.whitelist || []).map(w => w.toLowerCase()));
        this.effectiveWhitelist = new Set([...defaultNames, ...commonWords, ...userWhitelist]);
        console.log(`${LOG_PREFIX} User whitelist updated. Size: ${userWhitelist.size}`);
    }

    isPhraseLowQuality(phrase) {
        const words = phrase.toLowerCase().split(' '); // ensure lowercasing for whitelist check

        // Filter 1: Must be at least NGRAM_MIN words long.
        if (words.length < NGRAM_MIN) return true;

        // Filter 2: Check if phrase contains any user-whitelisted words or character names
        // These should cause phrases to be ignored entirely
        const userWhitelist = new Set((this.settings.whitelist || []).map(w => w.toLowerCase()));
        const hasWhitelistedWord = words.some(word => userWhitelist.has(word) || defaultNames.has(word));
        if (hasWhitelistedWord) return true;

        // Filter 3: Must contain at least one non-common word to be interesting
        // If all words in the phrase are common words, it's considered low quality
        const allCommonWords = words.every(word => commonWords.has(word));
        if (allCommonWords) return true;

        return false;
    }

    getBlacklistWeight(phrase) {
        const blacklist = this.settings.blacklist || {};
        if (Object.keys(blacklist).length === 0) return 0;
        const lowerCasePhrase = phrase.toLowerCase();
        let maxWeight = 0;
        for (const blacklistedTerm in blacklist) {
            if (lowerCasePhrase.includes(blacklistedTerm)) {
                maxWeight = Math.max(maxWeight, blacklist[blacklistedTerm]);
            }
        }
        return maxWeight;
    }

    analyzeAndTrackFrequency(text) {
        const cleanText = stripMarkup(text);
        if (!cleanText.trim()) return;

        // Use current settings values, not fallback defaults
        const NGRAM_MAX = this.settings.ngramMax;
        const SLOP_THRESHOLD = this.settings.slopThreshold;

        // Debug log settings values occasionally
        if (this.totalAiMessagesProcessed % 50 === 0) {
            console.log(`${LOG_PREFIX} Current analysis settings:`, {
                ngramMax: NGRAM_MAX,
                slopThreshold: SLOP_THRESHOLD,
                decayRate: this.settings.decayRate,
                decayInterval: this.settings.decayInterval,
                patternMinCommon: this.settings.patternMinCommon
            });
        }

        // CRITICAL CHANGE: Split text into sentences first to prevent cross-sentence n-grams.
        const sentences = cleanText.match(/[^.!?]+[.!?]+["]?/g) || [cleanText];

        for (const sentence of sentences) {
            if (!sentence.trim()) continue;

            const isDialogue = /["']/.test(sentence.trim().substring(0, 10));
            const chunkType = isDialogue ? 'dialogue' : 'narration';

            const originalWords = sentence.replace(/[.,!?]/g, '').toLowerCase().split(/\s+/).filter(Boolean);
            const lemmatizedWords = originalWords.map(word => lemmaMap.get(word) || word);

            for (let n = NGRAM_MIN; n <= NGRAM_MAX; n++) {
                if (originalWords.length < n) continue;

                const originalNgrams = generateNgrams(originalWords, n);
                const lemmatizedNgrams = generateNgrams(lemmatizedWords, n);

                for (let i = 0; i < originalNgrams.length; i++) {
                    const originalNgram = originalNgrams[i];
                    const lemmatizedNgram = lemmatizedNgrams[i];

                    if (this.isPhraseLowQuality(originalNgram)) {
                        continue;
                    }

                    const currentData = this.ngramFrequencies.get(lemmatizedNgram) || { count: 0, score: 0, lastSeenMessageIndex: this.totalAiMessagesProcessed, original: originalNgram, contextSentence: sentence };

                    let scoreIncrement = 1.0;

                    scoreIncrement += (n - NGRAM_MIN) * 0.2;
                    // Only use common words for scoring (not names or user whitelist)
                    const uncommonWordCount = originalNgram.split(' ').reduce((count, word) => count + (commonWords.has(word.toLowerCase()) ? 0 : 1), 0);
                    scoreIncrement += uncommonWordCount * 0.5;
                    scoreIncrement += this.getBlacklistWeight(originalNgram);
                    if (chunkType === 'narration') {
                        scoreIncrement *= 1.25;
                    }

                    const newCount = currentData.count + 1;
                    let newScore = currentData.score + scoreIncrement;

                    // OPTIMIZATION: Skip expensive boosting logic for performance
                    // The pattern merging algorithm already handles relationships between n-grams

                    this.ngramFrequencies.set(lemmatizedNgram, {
                        count: newCount,
                        score: newScore,
                        lastSeenMessageIndex: this.totalAiMessagesProcessed,
                        original: originalNgram,
                        contextSentence: sentence,
                    });

                    if (newScore >= SLOP_THRESHOLD && currentData.score < SLOP_THRESHOLD) {
                        this.processNewSlopCandidate(lemmatizedNgram);
                    }
                }
            }
        }
    }

    processNewSlopCandidate(newPhraseLemmatized) {
        // Simply add all candidates without removing substrings
        // The substring culling will happen later during pattern merging
        this.slopCandidates.add(newPhraseLemmatized);
    }
    
    pruneOldNgrams() {
        const DECAY_RATE = this.settings.decayRate || 10; // Default 10% decay
        const DECAY_INTERVAL = this.settings.decayInterval || 10; // Default interval of 10 messages
        const DECAY_MULTIPLIER = 1 - (DECAY_RATE / 100); // Convert percentage to multiplier
        
        let decayedCount = 0;
        
        for (const [ngram, data] of this.ngramFrequencies.entries()) {
            const messageAge = this.totalAiMessagesProcessed - data.lastSeenMessageIndex;
            
            if (messageAge > 0) {
                // Calculate how many decay cycles to apply based on message age
                const decayCycles = Math.floor(messageAge / DECAY_INTERVAL);
                
                if (decayCycles > 0) {
                    // Apply compound decay for the number of cycles
                    const totalDecayMultiplier = Math.pow(DECAY_MULTIPLIER, decayCycles);
                    data.score *= totalDecayMultiplier;
                    decayedCount++;
                }
            }
        }
        
        if (decayedCount > 0) {
            console.log(`${LOG_PREFIX} Decayed ${decayedCount} phrase scores (${DECAY_RATE}% per ${DECAY_INTERVAL} messages)`);
        }
    }

    pruneDuringManualAnalysis() {
        let prunedCount = 0;
        for (const [ngram, data] of this.ngramFrequencies.entries()) {
            if (data.score < 2 && data.count < 2) { 
                this.ngramFrequencies.delete(ngram);
                this.slopCandidates.delete(ngram);
                prunedCount++;
            }
        }
        if (prunedCount > 0) {
            console.log(`${LOG_PREFIX} [Manual Analysis] Pruned ${prunedCount} very low-score n-grams from chunk.`);
        }
    }

    mergeRelatedPatterns(patterns) {
        // Convert patterns to an array for processing
        const patternArray = Object.entries(patterns).map(([pattern, score]) => {
            const [prefix, variationsStr] = pattern.split('|');
            return {
                prefix: prefix.trim(),
                variations: variationsStr ? variationsStr.split('/').map(v => v.trim()) : [],
                score: score,
                fullPattern: pattern
            };
        });

        // Sort by prefix length (shortest first) to merge upward
        patternArray.sort((a, b) => a.prefix.split(' ').length - b.prefix.split(' ').length);

        const mergedResults = {};
        const consumedPatterns = new Set();

        for (let i = 0; i < patternArray.length; i++) {
            if (consumedPatterns.has(i)) continue;

            const basePattern = patternArray[i];
            let combinedVariations = new Set(basePattern.variations);
            let totalScore = basePattern.score;
            let shortestPrefix = basePattern.prefix;

            // Find all patterns that contain this prefix
            for (let j = 0; j < patternArray.length; j++) {
                if (i === j || consumedPatterns.has(j)) continue;

                const otherPattern = patternArray[j];

                // Check if one prefix ends with the other (they're related)
                if (otherPattern.prefix.endsWith(basePattern.prefix) ||
                    basePattern.prefix.endsWith(otherPattern.prefix)) {

                    // Use the shorter prefix as the base
                    if (otherPattern.prefix.length < shortestPrefix.length) {
                        shortestPrefix = otherPattern.prefix;
                    }

                    // Combine all variations
                    otherPattern.variations.forEach(v => combinedVariations.add(v));
                    totalScore += otherPattern.score;
                    consumedPatterns.add(j);
                }
            }

            // Only create a merged pattern if we have variations
            if (combinedVariations.size > 0) {
                const mergedPattern = `${shortestPrefix}|${Array.from(combinedVariations).join('/')}`;
                mergedResults[mergedPattern] = totalScore;
            } else {
                // Keep the original pattern
                mergedResults[basePattern.fullPattern] = basePattern.score;
            }
        }

        return mergedResults;
    }

    findAndMergePatterns(frequenciesObjectWithOriginals) {
        // OPTIMIZATION: Early exit if no data
        if (!frequenciesObjectWithOriginals || Object.keys(frequenciesObjectWithOriginals).length === 0) {
            return { merged: {}, remaining: {} };
        }

        const PATTERN_MIN_COMMON_WORDS = this.settings.patternMinCommon;
        const phraseScoreMap = {};
        for (const data of Object.values(frequenciesObjectWithOriginals)) {
            phraseScoreMap[data.original] = (phraseScoreMap[data.original] || 0) + data.score;
        }

        // Apply substring culling to remove redundant shorter phrases
        const culledPhrases = cullSubstrings(phraseScoreMap);

        // Then work with the culled phrases for pattern detection
        const candidates = Object.entries(culledPhrases).sort((a, b) => a[0].localeCompare(b[0]));
        const mergedPatterns = {};
        const consumedIndices = new Set();

        // Group phrases by length first - only merge phrases of the same length
        const phrasesByLength = {};
        candidates.forEach(([phrase, score], index) => {
            const length = phrase.split(' ').length;
            if (!phrasesByLength[length]) {
                phrasesByLength[length] = [];
            }
            phrasesByLength[length].push({ index, phrase, score });
        });

        // Process each length group to find patterns
        // OPTIMIZATION: Limit pattern detection to reasonable phrase lengths (3-10 words)
        for (const [length, lengthGroup] of Object.entries(phrasesByLength)) {
            if (lengthGroup.length < 2) continue; // Need at least 2 phrases to form a pattern
            if (parseInt(length) > 10) continue; // Skip very long phrases for performance

            for (let i = 0; i < lengthGroup.length; i++) {
                if (consumedIndices.has(lengthGroup[i].index)) continue;

                const phraseA = lengthGroup[i].phrase;
                const wordsA = phraseA.split(' ');
                let currentGroup = [lengthGroup[i]];

                // Find other phrases with the same length that share a common prefix
                for (let j = i + 1; j < lengthGroup.length; j++) {
                    if (consumedIndices.has(lengthGroup[j].index)) continue;

                    const phraseB = lengthGroup[j].phrase;
                    const wordsB = phraseB.split(' ');

                    // Count common prefix words
                    let commonPrefixLength = 0;
                    for (let k = 0; k < wordsA.length; k++) {
                        if (wordsA[k] === wordsB[k]) {
                            commonPrefixLength++;
                        } else {
                            break;
                        }
                    }

                    // Only group if they share enough prefix and have different endings
                    if (commonPrefixLength >= PATTERN_MIN_COMMON_WORDS &&
                        commonPrefixLength < wordsA.length) { // Ensure there's a variation part
                        currentGroup.push(lengthGroup[j]);
                    }
                }

                // If we found a group with variations, create a pattern
                if (currentGroup.length > 1) {
                    // Find the actual common prefix for all items in the group
                    let commonPrefixLength = currentGroup[0].phrase.split(' ').length;
                    for (let k = 1; k < currentGroup.length; k++) {
                        const words = currentGroup[k].phrase.split(' ');
                        const firstWords = currentGroup[0].phrase.split(' ');
                        let currentPrefixLength = 0;
                        while (currentPrefixLength < commonPrefixLength &&
                               currentPrefixLength < words.length &&
                               firstWords[currentPrefixLength] === words[currentPrefixLength]) {
                            currentPrefixLength++;
                        }
                        commonPrefixLength = Math.min(commonPrefixLength, currentPrefixLength);
                    }

                    if (commonPrefixLength >= PATTERN_MIN_COMMON_WORDS) {
                        const commonPrefix = currentGroup[0].phrase.split(' ').slice(0, commonPrefixLength).join(' ');
                        const variations = new Set();
                        let totalScore = 0;

                        currentGroup.forEach(item => {
                            totalScore += item.score;
                            consumedIndices.add(item.index);
                            const variationPart = item.phrase.split(' ').slice(commonPrefixLength).join(' ').trim();
                            if (variationPart) {
                                variations.add(variationPart);
                            }
                        });

                        if (variations.size > 1) { // Only create pattern if there are actual variations
                            const pattern = `${commonPrefix}|${Array.from(variations).join('/')}`;
                            mergedPatterns[pattern] = (mergedPatterns[pattern] || 0) + totalScore;
                        }
                    }
                }
            }
        }

        // Merge patterns that are subsets/extensions of each other
        const finalMergedPatterns = this.mergeRelatedPatterns(mergedPatterns);

        // For remaining phrases, apply very strict filtering
        // We want to focus on patterns, not random standalone phrases
        const remaining = {};

        // Option to completely disable standalone phrases (focus only on patterns)
        const includeStandalone = this.settings.includeStandalonePhrases !== false; // Default true for compatibility

        if (includeStandalone) {
            // If including standalone, use a much higher threshold to filter noise
            const STANDALONE_THRESHOLD_MULTIPLIER = 3.0; // Standalone phrases need 3x the threshold
            const standaloneThreshold = (this.settings.slopThreshold || 5) * STANDALONE_THRESHOLD_MULTIPLIER;

            for (let i = 0; i < candidates.length; i++) {
                if (!consumedIndices.has(i)) {
                    const [phrase, score] = candidates[i];
                    // Only include if it's really significant on its own
                    if (score >= standaloneThreshold) {
                        remaining[phrase] = score;
                    }
                }
            }
        }

        return { merged: finalMergedPatterns, remaining: remaining };
    }


    performIntermediateAnalysis() {
        if (this.ngramFrequencies.size === 0) {
            console.log(`${LOG_PREFIX} Skipping intermediate analysis - no n-grams collected yet.`);
            this.analyzedLeaderboardData = { merged: {}, remaining: {} };
            this.lastAnalysisMessageCount = this.totalAiMessagesProcessed;
            return;
        }

        let messagesSinceLast = this.totalAiMessagesProcessed - this.lastAnalysisMessageCount;
        if (messagesSinceLast < 0) {
            // Handle counter resets (e.g., manual re-analysis)
            this.lastAnalysisMessageCount = 0;
            messagesSinceLast = this.totalAiMessagesProcessed;
        }

        // OPTIMIZATION: Skip if already analyzed recently (within last 5 messages)
        if (this.lastAnalysisMessageCount !== 0 && messagesSinceLast < 5) {
            console.log(`${LOG_PREFIX} Skipping redundant analysis - only ${messagesSinceLast} new AI messages since last analysis (last at ${this.lastAnalysisMessageCount})`);
            return;
        }
        this.lastAnalysisMessageCount = this.totalAiMessagesProcessed;

        const candidatesWithData = {};
        for (const [phrase, data] of this.ngramFrequencies.entries()) {
            if (data.score > 1) {
                candidatesWithData[phrase] = data;
            }
        }
        const sortedCandidates = Object.entries(candidatesWithData).sort((a, b) => b[1].score - a[1].score);
        const limitedCandidates = Object.fromEntries(sortedCandidates.slice(0, CANDIDATE_LIMIT_FOR_ANALYSIS));

        if (Object.keys(candidatesWithData).length > CANDIDATE_LIMIT_FOR_ANALYSIS) {
            console.log(`${LOG_PREFIX} [Perf] Limited candidates from ${Object.keys(candidatesWithData).length} to ${CANDIDATE_LIMIT_FOR_ANALYSIS} BEFORE heavy processing.`);
        }
        
        const { merged, remaining } = this.findAndMergePatterns(limitedCandidates);
        
        const mergedEntries = Object.entries(merged).sort((a, b) => b[1] - a[1]);
        const allRemainingEntries = Object.entries(remaining).sort((a, b) => b[1] - a[1]);
        
        this.analyzedLeaderboardData = {
            merged: Object.fromEntries(mergedEntries),
            remaining: Object.fromEntries(allRemainingEntries),
        };
    }

    showFrequencyLeaderboard() {
        
        const { merged: mergedEntries, remaining: remainingEntries } = this.analyzedLeaderboardData;
        let contentHtml;
        const isProcessedDataAvailable = (mergedEntries && Object.keys(mergedEntries).length > 0) || (remainingEntries && Object.keys(remainingEntries).length > 0);

        if (isProcessedDataAvailable) {
            // Path 1: Show the fully processed, patterned data (the best view)
            const mergedRows = Object.entries(mergedEntries).map(([phrase, score]) => {
                // Format patterns with | separator for better display
                let displayPhrase = phrase;
                if (phrase.includes('|')) {
                    const [template, variations] = phrase.split('|');
                    displayPhrase = `${template.trim()} [${variations}]`;
                }
                return `<tr class="is-pattern"><td>${this.escapeHtml(displayPhrase)}</td><td>${score.toFixed(1)}</td></tr>`;
            }).join('');
            const remainingRows = Object.entries(remainingEntries).map(([phrase, score]) => `<tr><td>${this.escapeHtml(phrase)}</td><td>${score.toFixed(1)}</td></tr>`).join('');
            
            contentHtml = `<p>Showing <strong>processed and patterned</strong> slop data. Phrases in <strong>bold orange</strong> are detected patterns. This list updates automatically every 10 messages.</p>
                           <table class="prose-polisher-frequency-table">
                               <thead><tr><th>Repetitive Phrase or Pattern</th><th>Slop Score</th></tr></thead>
                               <tbody>${mergedRows}${remainingRows}</tbody>
                           </table>`;
        } else if (this.ngramFrequencies.size > 0) {
            // Path 2 (Fallback): Show raw, unprocessed data for immediate feedback
            const rawEntries = Array.from(this.ngramFrequencies.values())
                .filter(data => data.score > 0) // Only show items with a score
                .sort((a, b) => b.score - a.score);

            const rawRows = rawEntries.map(data => `<tr><td>${this.escapeHtml(data.original)}</td><td>${data.score.toFixed(1)}</td></tr>`).join('');
            
            contentHtml = `<p>Showing <strong>raw, unprocessed</strong> n-grams detected so far. This data is collected on every AI message and will be processed into patterns periodically.</p>
                           <table class="prose-polisher-frequency-table">
                               <thead><tr><th>Detected Phrase</th><th>Slop Score</th></tr></thead>
                               <tbody>${rawRows}</tbody>
                           </table>`;
        } else {
            // Path 3 (Final Fallback): Nothing has been detected at all
            contentHtml = '<p>No repetitive phrases have been detected yet. Send some AI messages to begin analysis.</p>';
        }

        this.callGenericPopup(contentHtml, this.POPUP_TYPE.TEXT, "Live Frequency Data (Slop Score)", { wide: true, large: true });
    }

   escapeHtml(unsafe) {
        if (typeof unsafe !== 'string') return '';
        return unsafe
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
    }

    showWhitelistManager() {
        const settings = this.settings;
        const container = document.createElement('div');
        container.className = 'prose-polisher-whitelist-manager';
        container.innerHTML = `
            <h4>Whitelist Manager</h4>
            <p>Add approved words to this list (e.g., character names, specific jargon). Any phrase containing these words will be <strong>completely ignored</strong> by the analyzer. Default character names are already filtered out automatically.</p>
            <div class="list-container">
                <ul id="pp-whitelist-list"></ul>
            </div>
            <div class="add-controls">
                <input type="text" id="pp-whitelist-input" class="text_pole" placeholder="Add a word to your whitelist...">
                <button id="pp-whitelist-add-btn" class="menu_button">Add</button>
            </div>
        `;
        const listElement = container.querySelector('#pp-whitelist-list');
        const inputElement = container.querySelector('#pp-whitelist-input');
        const addButton = container.querySelector('#pp-whitelist-add-btn');

        const renderWhitelist = () => {
            listElement.innerHTML = '';
            (settings.whitelist || []).sort().forEach(originalWord => {
                const item = document.createElement('li');
                item.className = 'list-item';
                const displayWord = this.escapeHtml(originalWord);
                item.innerHTML = `<span>${displayWord}</span><i class="fa-solid fa-trash-can delete-btn" data-word="${originalWord}"></i>`;
                item.querySelector('.delete-btn').addEventListener('pointerup', (event) => {
                    const wordToRemove = event.target.dataset.word; 
                    settings.whitelist = (settings.whitelist || []).filter(w => w !== wordToRemove);
                    this.saveSettingsDebounced();
                    this.updateEffectiveWhitelist(); 
                    renderWhitelist();
                });
                listElement.appendChild(item);
            });
        };

        const addWord = () => {
            const newWord = inputElement.value.trim().toLowerCase();
            if (newWord && !(settings.whitelist || []).includes(newWord)) {
                if (!settings.whitelist) settings.whitelist = [];
                settings.whitelist.push(newWord);
                this.saveSettingsDebounced();
                this.updateEffectiveWhitelist(); 
                renderWhitelist();
                inputElement.value = '';
            }
            inputElement.focus();
        };

        addButton.addEventListener('pointerup', addWord);
        inputElement.addEventListener('keydown', (event) => { if (event.key === 'Enter') addWord(); });

        renderWhitelist();
        this.callGenericPopup(container, this.POPUP_TYPE.DISPLAY, "Whitelist Manager", { wide: false, large: false });
    }

    showBlacklistManager() {
        const settings = this.settings;
        const container = document.createElement('div');
        container.className = 'prose-polisher-blacklist-manager';
        container.innerHTML = `
            <h4>Blacklist Manager (Weighted)</h4>
            <p>Add words to this list with a weight (1-10). Any phrase containing these words will get a score boost equal to the weight, making them much more likely to be flagged as slop.</p>
            <div class="list-container">
                <ul id="pp-blacklist-list"></ul>
            </div>
            <div class="add-controls">
                <input type="text" id="pp-blacklist-input" class="text_pole" placeholder="e.g., suddenly, began to" style="flex-grow: 3;">
                <input type="number" id="pp-blacklist-weight" class="text_pole" placeholder="Weight" value="3" min="1" max="10" style="flex-grow: 1;">
                <button id="pp-blacklist-add-btn" class="menu_button">Add</button>
            </div>
        `;
        const listElement = container.querySelector('#pp-blacklist-list');
        const inputElement = container.querySelector('#pp-blacklist-input');
        const weightElement = container.querySelector('#pp-blacklist-weight');
        const addButton = container.querySelector('#pp-blacklist-add-btn');

        const renderBlacklist = () => {
            listElement.innerHTML = '';
            const sortedBlacklist = Object.entries(settings.blacklist || {}).sort((a, b) => a[0].localeCompare(b[0]));
            
            sortedBlacklist.forEach(([originalWordKey, weight]) => {
                const item = document.createElement('li');
                item.className = 'list-item';
                const displayWord = this.escapeHtml(originalWordKey);
                item.innerHTML = `<span><strong>${displayWord}</strong> (Weight: ${weight})</span><i class="fa-solid fa-trash-can delete-btn" data-word="${originalWordKey}"></i>`;
                
                item.querySelector('.delete-btn').addEventListener('pointerup', (event) => {
                    const wordKeyToRemove = event.target.dataset.word; 
                    if (wordKeyToRemove && settings.blacklist && settings.blacklist.hasOwnProperty(wordKeyToRemove)) {
                        delete settings.blacklist[wordKeyToRemove];
                        this.saveSettingsDebounced();
                        renderBlacklist(); 
                    }
                });
                listElement.appendChild(item);
            });
        };

        const addWord = () => {
            const newWord = inputElement.value.trim().toLowerCase();
            const weight = parseInt(weightElement.value, 10);

            if (newWord && !isNaN(weight) && weight >= 1 && weight <= 10) {
                if (!settings.blacklist) settings.blacklist = {};
                settings.blacklist[newWord] = weight;
                this.saveSettingsDebounced();
                renderBlacklist();
                inputElement.value = '';
                inputElement.focus();
            } else {
                this.toastr.warning("Please enter a valid word and a weight between 1 and 10.");
            }
        };

        addButton.addEventListener('pointerup', addWord);
        inputElement.addEventListener('keydown', (event) => { if (event.key === 'Enter') addWord(); });
        weightElement.addEventListener('keydown', (event) => { if (event.key === 'Enter') addWord(); });
        
        renderBlacklist();
        this.callGenericPopup(container, this.POPUP_TYPE.DISPLAY, "Blacklist Manager", { wide: false, large: false });
    }


    clearFrequencyData() {
        this.ngramFrequencies.clear();
        this.slopCandidates.clear();
        this.messageCounterForTrigger = 0;
        this.analyzedLeaderboardData = { merged: {}, remaining: {} };
        this.lastAnalysisMessageCount = 0; // Reset analysis tracking
        this.totalAiMessagesProcessed = 0; // Reset message counter
        this.toastr.success("Prose Polisher frequency data cleared!");
    }

    incrementProcessedMessages() {
         this.totalAiMessagesProcessed++;
    }

    getSlopList() {
        const analyzedData = this.analyzedLeaderboardData || { merged: {}, remaining: {} };
        const hasAnalyzedData = (analyzedData.merged && Object.keys(analyzedData.merged).length > 0) ||
            (analyzedData.remaining && Object.keys(analyzedData.remaining).length > 0);

        if (this.ngramFrequencies.size === 0 && !hasAnalyzedData) {
            console.log(`${LOG_PREFIX} No n-gram data collected yet. Returning empty slop list.`);
            return [];
        }

        // If no analyzed data and we're not currently updating macro, perform analysis on demand
        if (!hasAnalyzedData && !this.isUpdatingMacro) {
            console.log(`${LOG_PREFIX} No analyzed data available, performing analysis for getSlopList`);
            this.performIntermediateAnalysis();
        }
        
        const latestData = this.analyzedLeaderboardData || { merged: {}, remaining: {} };
        const SLOP_THRESHOLD = this.settings.slopThreshold;
        const slopList = [];
        
        // Add merged patterns that exceed threshold
        for (const [pattern, score] of Object.entries(latestData.merged || {})) {
            if (score >= SLOP_THRESHOLD) {
                // Check if this is a pattern with variations (uses | separator)
                if (pattern.includes('|')) {
                    // Split by | to separate template from variations
                    const [template, variationString] = pattern.split('|');
                    
                    if (template && variationString) {
                        const variants = variationString.split('/').map(v => v.trim()).filter(v => v);
                        
                        slopList.push({
                            pattern_template: `${template.trim()} {variant}`,
                            variants: variants,
                            score: score,
                            type: 'pattern'
                        });
                    } else {
                        // Shouldn't happen but handle as regular phrase
                        slopList.push({
                            phrase: pattern,
                            score: score,
                            type: 'pattern'
                        });
                    }
                } else {
                    // Pattern without variations
                    slopList.push({
                        phrase: pattern,
                        score: score,
                        type: 'pattern'
                    });
                }
            }
        }
        
        // Add remaining individual phrases that exceed threshold
        for (const [phrase, score] of Object.entries(latestData.remaining || {})) {
            if (score >= SLOP_THRESHOLD) {
                slopList.push({
                    phrase: phrase,
                    score: score,
                    type: 'phrase'
                });
            }
        }
        
        // Sort by score descending
        slopList.sort((a, b) => b.score - a.score);
        
        console.log(`${LOG_PREFIX} getSlopList() returning ${slopList.length} items above threshold ${SLOP_THRESHOLD}`);
        return slopList;
    }

    async manualAnalyzeChatHistory() {
        if (this.isAnalyzingHistory) {
            this.toastr.warning("Prose Polisher: Chat history analysis is already in progress.");
            return;
        }

        this.isAnalyzingHistory = true;
        this.toastr.info("Prose Polisher: Starting chat history analysis...", "Chat Analysis", { timeOut: 2000 });
        console.log(`${LOG_PREFIX} Starting manual chat history analysis.`);

        const context = getContext();
        if (!context || !context.chat) {
            this.toastr.error("Prose Polisher: Could not get chat context for analysis.");
            this.isAnalyzingHistory = false;
            return;
        }

        // Check if we have enough messages to analyze
        const aiMessageCount = context.chat.filter(msg => !msg.is_user && msg.mes).length;
        if (aiMessageCount === 0) {
            this.toastr.info("Prose Polisher: No AI messages available to analyze yet.", "Insufficient Data");
            console.log(`${LOG_PREFIX} Manual analysis skipped - no AI messages in chat history.`);
            this.ngramFrequencies.clear();
            this.slopCandidates.clear();
            this.analyzedLeaderboardData = { merged: {}, remaining: {} };
            this.messageCounterForTrigger = 0;
            this.totalAiMessagesProcessed = 0;
            this.lastAnalysisMessageCount = 0;
            this.isAnalyzingHistory = false;
            if (this.updateSlopListMacro) {
                this.updateSlopListMacro();
            }
            return;
        }

        if (aiMessageCount < 5) {
            console.log(`${LOG_PREFIX} Proceeding with manual analysis using limited data set (${aiMessageCount} AI messages). Results may be noisy.`);
        }

        try {
            // Clear existing data
            this.ngramFrequencies.clear();
            this.slopCandidates.clear();
            this.totalAiMessagesProcessed = 0;

            // Log current settings being used for analysis
            console.log(`${LOG_PREFIX} Manual analysis using settings:`, {
                ngramMax: this.settings.ngramMax,
                slopThreshold: this.settings.slopThreshold,
                decayRate: this.settings.decayRate,
                decayInterval: this.settings.decayInterval,
                patternMinCommon: this.settings.patternMinCommon,
                messageLimit: this.settings.messageLimit
            });

            let chatMessages = context.chat;

            // Apply message limit if configured
            const messageLimit = this.settings.messageLimit || -1;
            if (messageLimit > 0) {
                // Get only the last N messages
                chatMessages = chatMessages.slice(-messageLimit);
                console.log(`${LOG_PREFIX} Limited analysis to last ${messageLimit} messages out of ${context.chat.length} total messages`);
            }

            let aiMessagesAnalyzed = 0;
            const batchSize = 10; // Process messages in smaller batches

            // Process messages in batches to avoid blocking UI
            for (let i = 0; i < chatMessages.length; i += batchSize) {
                const batch = chatMessages.slice(i, Math.min(i + batchSize, chatMessages.length));

                for (const message of batch) {
                    if (message.is_user || !message.mes || typeof message.mes !== 'string') {
                        continue;
                    }

                    this.analyzeAndTrackFrequency(message.mes);
                    aiMessagesAnalyzed++;
                    this.totalAiMessagesProcessed++;
                }

                // Yield to UI thread periodically
                if (i + batchSize < chatMessages.length) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            // Apply decay before final analysis
            this.pruneOldNgrams();

            // Perform final analysis
            this.performIntermediateAnalysis();

            // Update macro using the external function to avoid recursion
            if (this.updateSlopListMacro) {
                this.updateSlopListMacro();
            }

            this.isAnalyzingHistory = false;
            this.toastr.success(`Prose Polisher: Analysis complete! Analyzed ${aiMessagesAnalyzed} AI messages.`, "Chat Analysis Complete", { timeOut: 3000 });
            console.log(`${LOG_PREFIX} Manual chat history analysis complete. Analyzed ${aiMessagesAnalyzed} AI messages.`);

            this.showFrequencyLeaderboard();
        } catch (error) {
            console.error(`${LOG_PREFIX} Error during manual chat history analysis:`, error);
            this.toastr.error("Prose Polisher: An error occurred during chat analysis. Check console.", "Chat Analysis Error");
            this.isAnalyzingHistory = false;
        }
    }
}
