export { scanWorkspace, type ScannerOptions } from './scanner.js';
export { detectLanguage, detectLanguages, EXTENSION_TO_LANGUAGE, FILENAME_TO_LANGUAGE } from './language.js';
export { detectProjectMarkers, detectConfigFiles, detectRepoIndicators } from './markers.js';
export { classifySourceFile, TEST_PATTERNS, CONFIG_PATTERNS, DOC_PATTERNS, GENERATED_PATTERNS, IGNORED_DIRS } from './classify.js';