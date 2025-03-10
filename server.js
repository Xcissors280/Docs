const express = require('express');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 50400;
const DEFAULT_DOC_ID = '1hfLONQb1TJdHQ5Sm044gvi9UJtzhjlOMiXVymwFQgmA';

// Load service account email from credentials file
let serviceEmail;
try {
    const credentials = JSON.parse(fs.readFileSync('./credentials.json', 'utf8'));
    serviceEmail = credentials.client_email;
    console.log('Loaded service email:', serviceEmail);
} catch (error) {
    console.error('Error loading credentials file:', error);
    serviceEmail = 'Error loading service email';
}

// Setup Google Auth
const auth = new google.auth.GoogleAuth({
    keyFile: './credentials.json',
    scopes: ['https://www.googleapis.com/auth/documents.readonly'],
});

const docs = google.docs({ version: 'v1', auth });

// Cache for document content
const contentCache = new Map();

// Function to convert Google Doc to Markdown
function convertToMarkdown(document) {
    const title = document.title;
    let markdown = '';
    let inCodeBlock = false;
    let codeBlockLang = '';
    let listLevel = 0;
    let currentListType = null;
    
    document.body.content.forEach((element) => {
        if (element.paragraph) {
            const paragraph = element.paragraph;
            
            if (!paragraph.elements || paragraph.elements.length === 0) return;
            
            let paragraphText = '';
            const style = paragraph.paragraphStyle || {};
            
            // Handle headings
            if (style.namedStyleType?.includes('HEADING')) {
                const level = style.namedStyleType.match(/\d+$/);
                if (level) {
                    paragraphText = '#'.repeat(parseInt(level[0])) + ' ';
                }
            }
            
            // Handle lists
            if (paragraph.bullet) {
                const nesting = paragraph.bullet.nestingLevel || 0;
                const indent = '  '.repeat(nesting);
                
                if (paragraph.bullet.listId !== currentListType) {
                    currentListType = paragraph.bullet.listId;
                    listLevel = 0;
                }
                
                if (paragraph.bullet.glyph && paragraph.bullet.glyph.includes('●')) {
                    paragraphText = `${indent}- `;
                } else {
                    listLevel++;
                    paragraphText = `${indent}${listLevel}. `;
                }
            } else {
                currentListType = null;
                listLevel = 0;
            }
            
            // Process paragraph elements
            paragraph.elements.forEach((element) => {
                if (element.textRun) {
                    let content = element.textRun.content;
                    const textStyle = element.textRun.textStyle || {};
                    
                    // Handle text styles
                    if (textStyle.bold) content = `**${content}**`;
                    if (textStyle.italic) content = `*${content}*`;
                    if (textStyle.strikethrough) content = `~~${content}~~`;
                    
                    // Detect code blocks
                    const isCode = textStyle.fontFamily === 'Consolas' || 
                                 textStyle.backgroundColor?.color?.rgbColor?.red > 0.9;
                    
                    if (isCode) {
                        if (content.toLowerCase().includes('powershell')) {
                            if (!inCodeBlock) {
                                inCodeBlock = true;
                                codeBlockLang = 'powershell';
                                content = '```powershell\n' + content.trim();
                            }
                        } else if (content.includes('\n') && !inCodeBlock) {
                            inCodeBlock = true;
                            content = '```\n' + content.trim();
                        } else if (!inCodeBlock && content.trim()) {
                            content = '`' + content.trim() + '`';
                        }
                    } else if (inCodeBlock && content.trim() === '') {
                        inCodeBlock = false;
                        content = '\n```\n\n';
                    }
                    
                    // Handle links
                    if (textStyle.link) {
                        content = `[${content.trim()}](${textStyle.link.url})`;
                    }
                    
                    paragraphText += content;
                }
            });

            if (paragraphText.trim()) {
                markdown += paragraphText;
                if (!inCodeBlock) {
                    markdown += currentListType ? '\n' : '\n\n';
                }
            }
        }

        // Handle tables
        if (element.table) {
            const table = element.table;
            let tableContent = '\n';
            
            table.tableRows.forEach((row, rowIndex) => {
                const cells = row.tableCells.map(cell => {
                    return cell.content.map(content => 
                        content.paragraph.elements.map(element => 
                            element.textRun?.content || ''
                        ).join('')
                    ).join('').trim() || ' ';
                });
                
                tableContent += '| ' + cells.join(' | ') + ' |\n';
                
                if (rowIndex === 0) {
                    tableContent += '|' + cells.map(() => '---').join('|') + '|\n';
                }
            });
            
            markdown += tableContent + '\n';
        }
    });
    
    return {
        title,
        content: markdown.trim()
    };
}

// Update content from Google Docs
async function updateContent(docId) {
    try {
        console.log(`Fetching document from Google: ${docId}`);
        const response = await docs.documents.get({
            documentId: docId
        });
        
        console.log(`Received document from Google: ${response.data.title}`);
        const content = convertToMarkdown(response.data);
        
        contentCache.set(docId, {
            title: content.title,
            content: content.content,
            docId,
            lastUpdate: new Date()
        });
        
        return contentCache.get(docId);
    } catch (error) {
        console.error('Error fetching document:', error);
        throw error;
    }
}

// Serve static files
app.use(express.static('public'));

// API endpoint to get service email
app.get('/api/service-email', (req, res) => {
    console.log('Service email requested');
    res.json({ email: serviceEmail });
});

// API endpoint to get content
app.get('/api/content', async (req, res) => {
    try {
        const docId = req.query.docId || DEFAULT_DOC_ID;
        console.log(`Content requested for document: ${docId}`);
        
        // Check cache first
        let content = contentCache.get(docId);
        const cacheHit = !!content;
        console.log(`Cache hit: ${cacheHit}`);
        
        // Refresh if content is older than 5 minutes or not in cache
        if (!content || (Date.now() - content.lastUpdate) > 5 * 60 * 1000) {
            console.log('Fetching fresh content');
            content = await updateContent(docId);
        }
        
        if (!content) {
            throw new Error('No content received from Google Docs');
        }
        
        res.json({
            title: content.title,
            content: content.content,
            docId: docId,
            lastUpdate: content.lastUpdate
        });
    } catch (error) {
        console.error('Error serving content:', error);
        res.status(500).json({ 
            error: 'Failed to fetch document',
            message: error.message
        });
    }
});

// Handle document ID in URL path
app.get('/:docIdOrPath(*)', (req, res, next) => {
    const docIdOrPath = req.params.docIdOrPath;
    
    // If this is a static file or API request, continue to next handler
    if (docIdOrPath.startsWith('api/') || 
        docIdOrPath.includes('.')) {
        return next();
    }
    
    // Extract document ID from path if it contains a Google Docs URL pattern
    let docId;
    
    // Check for document ID in various URL formats
    const urlMatch = docIdOrPath.match(/document\/d\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) {
        // Found a Google Docs URL pattern
        docId = urlMatch[1];
        
        // Redirect to the clean URL with just the document ID
        return res.redirect(`/${docId}`);
    } else if (docIdOrPath.match(/^[a-zA-Z0-9_-]{25,}$/)) {
        // It's already a clean document ID
        docId = docIdOrPath;
    } else if (docIdOrPath.includes('docs.google.com')) {
        // It's a full Google Docs URL or a URL without https://
        const fullUrlMatch = docIdOrPath.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
        if (fullUrlMatch) {
            docId = fullUrlMatch[1];
            // Redirect to the clean URL with just the document ID
            return res.redirect(`/${docId}`);
        }
    }
    
    // Serve the index.html file (client-side will handle the document loading)
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
    console.log(`Default document ID: ${DEFAULT_DOC_ID}`);
});