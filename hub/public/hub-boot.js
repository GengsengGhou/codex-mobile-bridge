import { createI18n } from "/i18n.js";
import { initializeHub } from "/hub.js";

initializeHub({ document, window, i18n: createI18n({ window, document }) });
