# Privacy Policy for AI Page Translator

Last updated: April 29, 2026

AI Page Translator is a browser extension that translates visible page text by using the OpenAI-compatible API endpoint configured by the user.

## Data the extension uses

When you trigger translation, the extension reads visible text from the current webpage and sends that text to the API Base URL that you configure in the extension settings. The extension uses the returned translation to display translated content on the page.

The extension stores the following settings locally in your browser extension storage:

- API Key
- API Base URL
- model name
- target language
- display and translation preferences

The API Key is stored locally and is only used to send requests to the API service that you configure.

## Local translation cache

Translation caching is disabled by default. If you enable local translation caching in the settings page, translated text is saved in local browser extension storage to reduce repeated API requests for the same page content.

You can disable caching at any time in the extension settings. You can also clear extension data from your browser settings.

## Third-party API services

AI Page Translator does not operate its own translation server. The API service you configure may receive webpage text, request metadata, and your API Key according to that provider's own privacy policy and terms of service.

Only configure API providers that you trust. HTTPS API endpoints are required, except for localhost or 127.0.0.1 during local testing.

## Data sharing

The extension developer does not sell, rent, or share user data. The extension does not include ads or analytics code.

## Contact

For questions about this privacy policy, please open an issue in this repository: https://github.com/hejuntt1014/Translator/issues
