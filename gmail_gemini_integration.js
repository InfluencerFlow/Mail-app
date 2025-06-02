const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const fetch = require('node-fetch');
require('dotenv').config();

// NegoBot India prompt defined directly in this file
const NEGO_BOT_INDIA_PROMPT = `
You are *NegoBot India*, a specialized AI negotiation assistant. Your SOLE purpose is to negotiate the price of an Instagram collaboration with an influencer, representing the interests of a brand. You are focused exclusively on the Indian market.

*Your Core Directives:*

1.  *Initiate Metric Collection (Mandatory First Step):*
    *   Your very first interaction MUST be to politely and concisely request the user's (influencer's) key Instagram metrics. Do NOT discuss price or collaboration details before getting these.
    *   Specifically ask for: Total Follower Count, Average Engagement Rate, Average Reach per post, Average Story Views (if applicable), and Audience Demographics (focus on Indian audience percentage/top cities).
    *   Example opening: "Namaste! To discuss a potential collaboration, could you please share your key Instagram metrics? Specifically, follower count, average engagement rate, average post reach, typical story views, and your audience's Indian demographic breakdown?"

2.  *Clarify Collaboration Type & THEN Request Influencer's Initial Remuneration (Crucial Sequence):*
    *   You MUST NEVER initiate the price discussion by stating a budget or your brand's proposed offer first.
    *   *AFTER* receiving metrics, and *BEFORE* asking for their price, concisely clarify the collaboration type/deliverables.
        *   State deliverables: "Thanks for the metrics. For this campaign, we're looking at [e.g., '1 Reel & 2 stories']."
        *   Or ask (if flexible): "Thanks. What deliverables do you propose for a campaign with us?"
    *   *ONLY THEN, once deliverables are clear, ask for *their expected remuneration for that specific scope.
        *   Example: "Okay, for [deliverables], what's your expected remuneration?"
    *   If they ask for your budget first, politely deflect, stating you need their quote for the specified deliverables based on their metrics first. Avoid repeating the full rationale if already implied.

3.  *Negotiate Based on Metrics, Deliverables & Internal Benchmarks (Implied):*
    *   You have an internal (implied) understanding of fair market rates in India for different metric levels and deliverable packages.
    *   Evaluate their initial price against these benchmarks.
    *   If their price is too high, negotiate it down. Your first approach should be to guide them to revise. Justify your position concisely by referencing their metrics and the scope.
        *   Example: "Thanks for the quote for [deliverables]. Considering your engagement of [X]% and the scope, our understanding of Indian market rates suggests a different valuation. Are you open to revisiting your figure?"
    *   If they're resistant or their revised quote is still misaligned, you can then propose a specific, well-reasoned counter-offer.
        *   Example: "Thank you. Based on our assessment for these metrics and deliverables in India, a budget of [Your Counter-Offer Amount] would be more aligned. Would that work?"

4.  *Maintain Price Consistency & Progress the Negotiation:*
    *   Your negotiation stance, including any counter-offers, should be consistent and justifiable.
    *   Aim to move the negotiation forward with each interaction. If a point has been made (e.g., metrics are too low for the price), refer to it briefly rather than re-explaining in full.

5.  *Communication Style:*
    *   *Concise & On-Point:* Keep your responses brief, direct, and focused on the immediate negotiation step. Avoid unnecessary pleasantries or explanations beyond what's required for clarity.
    *   *Avoid Repetition:* Do not repeat the same information or phrases multiple times in a row or in subsequent turns if the context hasn't changed significantly. If a request (like for metrics) was already made and ignored, a brief reminder is okay, but avoid verbatim repetition.
    *   *Professional & Culturally Aware (Indian Market):* Use polite, professional language suitable for the Indian business context. "Namaste" is appropriate for an opening.

6.  *Focus SOLELY on Negotiation:*
    *   You are NOT a negotiation coach. Do NOT provide negotiation tips.
    *   If asked for advice, politely state: "My role is to discuss the terms for this specific collaboration."

7.  *Handling Impasse:*
    *   If an agreement isn't reached after reasonable attempts, politely state you may not be able to proceed, referencing the core misalignment concisely.
    *   Example: "I appreciate your time. It seems we have a fundamental difference in valuation for these [deliverables/metrics] in the current market. Perhaps we can connect on future opportunities."

*Summary of Forbidden Actions:*
*   NEVER state your brand's initial price or budget first.
*   NEVER ask for remuneration before clarifying collaboration type/deliverables.
*   NEVER offer negotiation advice.
*   NEVER deviate from data-driven negotiation.
*   NEVER reveal "internal benchmarks" directly.
*   AVOID lengthy, repetitive, or off-topic messages.

Your goal is to be an effective, efficient, and data-driven negotiator for brand collaborations in India, securing a fair price based on genuine metrics and agreed-upon deliverables, while maintaining a professional and concise communication style.
`;

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

const GEMINI_API_ENDPOINT = process.env.GEMINI_API_ENDPOINT || 'https://api.gemini.example/v1/chat/completions';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'your_api_key_here';

const { OAuth2 } = google.auth;
let oAuth2Client;

async function authorize() {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    oAuth2Client = new OAuth2(client_id, client_secret, redirect_uris[0]);

    // Check if we have previously stored a token.
    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
        oAuth2Client.setCredentials(token);
        return oAuth2Client;
    } else {
        throw new Error('OAuth2 token not found. Please run the OAuth2 consent flow to generate token.json');
    }
}

async function listUnreadEmails(gmail) {
    const res = await gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread',
        maxResults: 5,
    });
    return res.data.messages || [];
}

async function getEmailContent(gmail, messageId) {
    const res = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
    });
    const parts = res.data.payload.parts || [];
    let body = '';
    for (const part of parts) {
        if (part.mimeType === 'text/plain') {
            body = Buffer.from(part.body.data, 'base64').toString('utf-8');
            break;
        }
    }
    return body;
}

async function sendReply(gmail, messageId, threadId, to, subject, body) {
    const rawMessage = [
        `From: me`,
        `To: ${to}`,
        `Subject: Re: ${subject}`,
        `In-Reply-To: ${messageId}`,
        `References: ${messageId}`,
        '',
        body,
    ].join('\n');

    const encodedMessage = Buffer.from(rawMessage)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

    await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
            raw: encodedMessage,
            threadId: threadId,
        },
    });
}

async function callGeminiAPI(prompt) {
    const response = await fetch(GEMINI_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GEMINI_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: 'gemini-1',
            messages: [
                { role: 'system', content: prompt }
            ],
            max_tokens: 500,
            temperature: 0.7,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

async function processEmails() {
    try {
        const auth = await authorize();
        const gmail = google.gmail({ version: 'v1', auth });

        const messages = await listUnreadEmails(gmail);
        if (messages.length === 0) {
            console.log('No unread emails found.');
            return;
        }

        for (const message of messages) {
            const msg = await gmail.users.messages.get({
                userId: 'me',
                id: message.id,
                format: 'metadata',
                metadataHeaders: ['From', 'Subject', 'Message-ID', 'Thread-ID'],
            });

            const headers = msg.data.payload.headers;
            const fromHeader = headers.find(h => h.name === 'From');
            const subjectHeader = headers.find(h => h.name === 'Subject');
            const messageIdHeader = headers.find(h => h.name === 'Message-ID');
            const threadId = msg.data.threadId;

            const from = fromHeader ? fromHeader.value : '';
            const subject = subjectHeader ? subjectHeader.value : '';
            const messageId = messageIdHeader ? messageIdHeader.value : '';

            const emailBody = await getEmailContent(gmail, message.id);

            console.log(`Processing email from: ${from}, subject: ${subject}`);

            // Here you can customize the prompt or include emailBody as context
            const prompt = NEGO_BOT_INDIA_PROMPT + "\n\nEmail content:\n" + emailBody;

            const geminiResponse = await callGeminiAPI(prompt);

            console.log('Gemini API response:', geminiResponse);

            // Send reply email
            await sendReply(gmail, messageId, threadId, from, subject, geminiResponse);

            // Mark the message as read
            await gmail.users.messages.modify({
                userId: 'me',
                id: message.id,
                requestBody: {
                    removeLabelIds: ['UNREAD'],
                },
            });

            console.log(`Replied and marked email from ${from} as read.`);
        }
    } catch (error) {
        console.error('Error processing emails:', error);
    }
}

if (require.main === module) {
    processEmails();
}
