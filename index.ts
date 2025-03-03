#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runAppleScript } from "run-applescript";
import tools from "./tools";

interface Reminder {
  name: string;
  id: string;
  body: string;
  completed: boolean;
  dueDate: string | null;
  listName: string;
  completionDate?: string | null;
  creationDate?: string | null;
  modificationDate?: string | null;
  remindMeDate?: string | null;
  priority?: number;
}

interface SearchResult {
  title: string;
  url: string;
  displayUrl: string;
  snippet: string;
}

interface WebSearchArgs {
  query: string;
}

// Safe mode implementation - lazy loading of modules
let useEagerLoading = true;
let loadingTimeout: NodeJS.Timeout | null = null;
let safeModeFallback = false;

console.error("Starting apple-mcp server...");

// Placeholders for modules - will either be loaded eagerly or lazily
let contacts: typeof import('./utils/contacts').default | null = null;
let notes: typeof import('./utils/notes').default | null = null;
let message: typeof import('./utils/message').default | null = null;
let mail: typeof import('./utils/mail').default | null = null;
let reminders: typeof import('./utils/reminders').default | null = null;
let webSearch: typeof import('./utils/webSearch').default | null = null;

// Type map for module names to their types
type ModuleMap = {
  contacts: typeof import('./utils/contacts').default;
  notes: typeof import('./utils/notes').default;
  message: typeof import('./utils/message').default;
  mail: typeof import('./utils/mail').default;
  reminders: typeof import('./utils/reminders').default;
  webSearch: typeof import('./utils/webSearch').default;
};

// Helper function for lazy module loading
async function loadModule<T extends 'contacts' | 'notes' | 'message' | 'mail' | 'reminders' | 'webSearch'>(moduleName: T): Promise<ModuleMap[T]> {
  if (safeModeFallback) {
    console.error(`Loading ${moduleName} module on demand (safe mode)...`);
  }
  
  try {
    switch (moduleName) {
      case 'contacts':
        if (!contacts) contacts = (await import('./utils/contacts')).default;
        return contacts as ModuleMap[T];
      case 'notes':
        if (!notes) notes = (await import('./utils/notes')).default;
        return notes as ModuleMap[T];
      case 'message':
        if (!message) message = (await import('./utils/message')).default;
        return message as ModuleMap[T];
      case 'mail':
        if (!mail) mail = (await import('./utils/mail')).default;
        return mail as ModuleMap[T];
      case 'reminders':
        if (!reminders) reminders = (await import('./utils/reminders')).default;
        return reminders as ModuleMap[T];
      case 'webSearch':
        if (!webSearch) webSearch = (await import('./utils/webSearch')).default;
        return webSearch as ModuleMap[T];
      default:
        throw new Error(`Unknown module: ${moduleName}`);
    }
  } catch (error) {
    console.error(`Error loading ${moduleName} module:`, error);
    throw error;
  }
}

// Set a timeout to switch to safe mode if initialization takes too long
loadingTimeout = setTimeout(() => {
  console.error("Loading timeout reached. Switching to safe mode (lazy loading...)");
  useEagerLoading = false;
  safeModeFallback = true;
  
  // Clear the references to any modules that might be in a bad state
  contacts = null;
  notes = null;
  message = null;
  mail = null;
  reminders = null;
  
  // Proceed with server setup
  initServer();
}, 5000); // 5 second timeout

// Eager loading attempt
async function attemptEagerLoading() {
  try {
    console.error("Attempting to eagerly load modules...");
    
    // Try to import all modules
    contacts = (await import('./utils/contacts')).default;
    console.error("- Contacts module loaded successfully");
    
    notes = (await import('./utils/notes')).default;
    console.error("- Notes module loaded successfully");
    
    message = (await import('./utils/message')).default;
    console.error("- Message module loaded successfully");
    
    mail = (await import('./utils/mail')).default;
    console.error("- Mail module loaded successfully");
    
    reminders = (await import('./utils/reminders')).default;
    console.error("- Reminders module loaded successfully");
    
    // If we get here, clear the timeout and proceed with eager loading
    if (loadingTimeout) {
      clearTimeout(loadingTimeout);
      loadingTimeout = null;
    }
    
    console.error("All modules loaded successfully, using eager loading mode");
    initServer();
  } catch (error) {
    console.error("Error during eager loading:", error);
    console.error("Switching to safe mode (lazy loading)...");
    
    // Clear any timeout if it exists
    if (loadingTimeout) {
      clearTimeout(loadingTimeout);
      loadingTimeout = null;
    }
    
    // Switch to safe mode
    useEagerLoading = false;
    safeModeFallback = true;
    
    // Clear the references to any modules that might be in a bad state
    contacts = null;
    notes = null;
    message = null;
    mail = null;
    reminders = null;
    
    // Initialize the server in safe mode
    initServer();
  }
}

// Attempt eager loading first
attemptEagerLoading();

// Main server object
let server: Server;

// Initialize the server and set up handlers
function initServer() {
  console.error(`Initializing server in ${safeModeFallback ? 'safe' : 'standard'} mode...`);
  
  server = new Server(
    {
      name: "Apple MCP tools",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;

      if (!args) {
        throw new Error("No arguments provided");
      }

      switch (name) {
        case "contacts": {
          if (!isContactsArgs(args)) {
            throw new Error("Invalid arguments for contacts tool");
          }

          try {
            const contactsModule = await loadModule('contacts');
            
            if (args.name) {
              const numbers = await contactsModule.findNumber(args.name);
              return {
                content: [{
                  type: "text",
                  text: numbers.length ? 
                    `${args.name}: ${numbers.join(", ")}` :
                    `No contact found for "${args.name}". Try a different name or use no name parameter to list all contacts.`
                }],
                isError: false
              };
            } else {
              const allNumbers = await contactsModule.getAllNumbers();
              const contactCount = Object.keys(allNumbers).length;
              
              if (contactCount === 0) {
                return {
                  content: [{
                    type: "text",
                    text: "No contacts found in the address book. Please make sure you have granted access to Contacts."
                  }],
                  isError: false
                };
              }

              const formattedContacts = Object.entries(allNumbers)
                .filter(([_, phones]) => phones.length > 0)
                .map(([name, phones]) => `${name}: ${phones.join(", ")}`);

              return {
                content: [{
                  type: "text",
                  text: formattedContacts.length > 0 ?
                    `Found ${contactCount} contacts:\n\n${formattedContacts.join("\n")}` :
                    "Found contacts but none have phone numbers. Try searching by name to see more details."
                }],
                isError: false
              };
            }
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Error accessing contacts: ${error instanceof Error ? error.message : String(error)}`
              }],
              isError: true
            };
          }
        }
        
        case "notes": {
          if (!isNotesArgs(args)) {
            throw new Error("Invalid arguments for notes tool");
          }

          try {
            const notesModule = await loadModule('notes');
            
            if (args.searchText) {
              const foundNotes = await notesModule.findNote(args.searchText);
              return {
                content: [{
                  type: "text",
                  text: foundNotes.length ?
                    foundNotes.map(note => `${note.name}:\n${note.content}`).join("\n\n") :
                    `No notes found for "${args.searchText}"`
                }],
                isError: false
              };
            } else {
              const allNotes = await notesModule.getAllNotes();

              return {
                content: [{
                  type: "text",
                  text: allNotes.length ?
                    allNotes.map((note) => `${note.name}:\n${note.content}`)
                    .join("\n\n") : 
                    "No notes exist."
                }],
                isError: false
              };
            }
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Error accessing notes: ${error instanceof Error ? error.message : String(error)}`
              }],
              isError: true
            };
          }
        }

        case "messages": {
          if (!isMessagesArgs(args)) {
            throw new Error("Invalid arguments for messages tool");
          }

          try {
            const messageModule = await loadModule('message');
            
            switch (args.operation) {
              case "send": {
                if (!args.phoneNumber || !args.message) {
                  throw new Error("Phone number and message are required for send operation");
                }
                await messageModule.sendMessage(args.phoneNumber, args.message);
                return {
                  content: [{ type: "text", text: `Message sent to ${args.phoneNumber}` }],
                  isError: false
                };
              }

              case "read": {
                if (!args.phoneNumber) {
                  throw new Error("Phone number is required for read operation");
                }
                const messages = await messageModule.readMessages(args.phoneNumber, args.limit);
                return {
                  content: [{ 
                    type: "text", 
                    text: messages.length > 0 ? 
                      messages.map(msg => 
                        `[${new Date(msg.date).toLocaleString()}] ${msg.is_from_me ? 'Me' : msg.sender}: ${msg.content}`
                      ).join("\n") :
                      "No messages found"
                  }],
                  isError: false
                };
              }

              case "schedule": {
                if (!args.phoneNumber || !args.message || !args.scheduledTime) {
                  throw new Error("Phone number, message, and scheduled time are required for schedule operation");
                }
                const scheduledMsg = await messageModule.scheduleMessage(
                  args.phoneNumber,
                  args.message,
                  new Date(args.scheduledTime)
                );
                return {
                  content: [{ 
                    type: "text", 
                    text: `Message scheduled to be sent to ${args.phoneNumber} at ${scheduledMsg.scheduledTime}` 
                  }],
                  isError: false
                };
              }

              case "unread": {
                const messages = await messageModule.getUnreadMessages(args.limit);
                
                // Look up contact names for all messages
                const contactsModule = await loadModule('contacts');
                const messagesWithNames = await Promise.all(
                  messages.map(async msg => {
                    // Only look up names for messages not from me
                    if (!msg.is_from_me) {
                      const contactName = await contactsModule.findContactByPhone(msg.sender);
                      return {
                        ...msg,
                        displayName: contactName || msg.sender // Use contact name if found, otherwise use phone/email
                      };
                    }
                    return {
                      ...msg,
                      displayName: 'Me'
                    };
                  })
                );

                return {
                  content: [{ 
                    type: "text", 
                    text: messagesWithNames.length > 0 ? 
                      `Found ${messagesWithNames.length} unread message(s):\n` +
                      messagesWithNames.map(msg => 
                        `[${new Date(msg.date).toLocaleString()}] From ${msg.displayName}:\n${msg.content}`
                      ).join("\n\n") :
                      "No unread messages found"
                  }],
                  isError: false
                };
              }

              default:
                throw new Error(`Unknown operation: ${args.operation}`);
            }
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Error with messages operation: ${error instanceof Error ? error.message : String(error)}`
              }],
              isError: true
            };
          }
        }

        case "mail": {
          if (!isMailArgs(args)) {
            throw new Error("Invalid arguments for mail tool");
          }

          try {
            const mailModule = await loadModule('mail');
            
            switch (args.operation) {
              case "unread": {
                // If an account is specified, we'll try to search specifically in that account
                let emails;
                if (args.account) {
                  console.error(`Getting unread emails for account: ${args.account}`);
                  // Use AppleScript to get unread emails from specific account
                  const script = `
tell application "Mail"
    set resultList to {}
    try
        set targetAccount to first account whose name is "${args.account.replace(/"/g, '\\"')}"
        
        -- Get mailboxes for this account
        set acctMailboxes to every mailbox of targetAccount
        
        -- If mailbox is specified, only search in that mailbox
        set mailboxesToSearch to acctMailboxes
        ${args.mailbox ? `
        set mailboxesToSearch to {}
        repeat with mb in acctMailboxes
            if name of mb is "${args.mailbox.replace(/"/g, '\\"')}" then
                set mailboxesToSearch to {mb}
                exit repeat
            end if
        end repeat
        ` : ''}
        
        -- Search specified mailboxes
        repeat with mb in mailboxesToSearch
            try
                set unreadMessages to (messages of mb whose read status is false)
                if (count of unreadMessages) > 0 then
                    set msgLimit to ${args.limit || 10}
                    if (count of unreadMessages) < msgLimit then
                        set msgLimit to (count of unreadMessages)
                    end if
                    
                    repeat with i from 1 to msgLimit
                        try
                            set currentMsg to item i of unreadMessages
                            set msgData to {subject:(subject of currentMsg), sender:(sender of currentMsg), ¬
                                        date:(date sent of currentMsg) as string, mailbox:(name of mb)}
                            
                            -- Try to get content if possible
                            try
                                set msgContent to content of currentMsg
                                if length of msgContent > 500 then
                                    set msgContent to (text 1 thru 500 of msgContent) & "..."
                                end if
                                set msgData to msgData & {content:msgContent}
                            on error
                                set msgData to msgData & {content:"[Content not available]"}
                            end try
                            
                            set end of resultList to msgData
                        on error
                            -- Skip problematic messages
                        end try
                    end repeat
                    
                    if (count of resultList) ≥ ${args.limit || 10} then exit repeat
                end if
            on error
                -- Skip problematic mailboxes
            end try
        end repeat
    on error errMsg
        return "Error: " & errMsg
    end try
    
    return resultList
end tell`;
                  
                  try {
                    const asResult = await runAppleScript(script);
                    if (asResult && asResult.startsWith('Error:')) {
                      throw new Error(asResult);
                    }
                    
                    // Parse the results - similar to general getUnreadMails
                    const emailData = [];
                    const matches = asResult.match(/\{([^}]+)\}/g);
                    if (matches && matches.length > 0) {
                      for (const match of matches) {
                        try {
                          const props = match.substring(1, match.length - 1).split(',');
                          const email: any = {};
                          
                          props.forEach(prop => {
                            const parts = prop.split(':');
                            if (parts.length >= 2) {
                              const key = parts[0].trim();
                              const value = parts.slice(1).join(':').trim();
                              email[key] = value;
                            }
                          });
                          
                          if (email.subject || email.sender) {
                            emailData.push({
                              subject: email.subject || "No subject",
                              sender: email.sender || "Unknown sender",
                              dateSent: email.date || new Date().toString(),
                              content: email.content || "[Content not available]",
                              isRead: false,
                              mailbox: `${args.account} - ${email.mailbox || "Unknown"}`
                            });
                          }
                        } catch (parseError) {
                          console.error('Error parsing email match:', parseError);
                        }
                      }
                    }
                    
                    emails = emailData;
                  } catch (error) {
                    console.error('Error getting account-specific emails:', error);
                    // Fallback to general method if specific account fails
                    emails = await mailModule.getUnreadMails(args.limit);
                  }
                } else {
                  // No account specified, use the general method
                  emails = await mailModule.getUnreadMails(args.limit);
                }
                
                return {
                  content: [{ 
                    type: "text", 
                    text: emails.length > 0 ? 
                      `Found ${emails.length} unread email(s)${args.account ? ` in account "${args.account}"` : ''}${args.mailbox ? ` and mailbox "${args.mailbox}"` : ''}:\n\n` +
                      emails.map((email: any) => 
                        `[${email.dateSent}] From: ${email.sender}\nMailbox: ${email.mailbox}\nSubject: ${email.subject}\n${email.content.substring(0, 500)}${email.content.length > 500 ? '...' : ''}`
                      ).join("\n\n") :
                      `No unread emails found${args.account ? ` in account "${args.account}"` : ''}${args.mailbox ? ` and mailbox "${args.mailbox}"` : ''}`
                  }],
                  isError: false
                };
              }

              case "search": {
                if (!args.searchTerm) {
                  throw new Error("Search term is required for search operation");
                }
                const emails = await mailModule.searchMails(args.searchTerm, args.limit);
                return {
                  content: [{ 
                    type: "text", 
                    text: emails.length > 0 ? 
                      `Found ${emails.length} email(s) for "${args.searchTerm}"${args.account ? ` in account "${args.account}"` : ''}${args.mailbox ? ` and mailbox "${args.mailbox}"` : ''}:\n\n` +
                      emails.map((email: any) => 
                        `[${email.dateSent}] From: ${email.sender}\nMailbox: ${email.mailbox}\nSubject: ${email.subject}\n${email.content.substring(0, 200)}${email.content.length > 200 ? '...' : ''}`
                      ).join("\n\n") :
                      `No emails found for "${args.searchTerm}"${args.account ? ` in account "${args.account}"` : ''}${args.mailbox ? ` and mailbox "${args.mailbox}"` : ''}`
                  }],
                  isError: false
                };
              }

              case "send": {
                if (!args.to || !args.subject || !args.body) {
                  throw new Error("Recipient (to), subject, and body are required for send operation");
                }
                const result = await mailModule.sendMail(args.to, args.subject, args.body, args.cc, args.bcc);
                return {
                  content: [{ type: "text", text: result }],
                  isError: false
                };
              }

              case "mailboxes": {
                if (args.account) {
                  const mailboxes = await mailModule.getMailboxesForAccount(args.account);
                  return {
                    content: [{ 
                      type: "text", 
                      text: mailboxes.length > 0 ? 
                        `Found ${mailboxes.length} mailboxes for account "${args.account}":\n\n${mailboxes.join("\n")}` :
                        `No mailboxes found for account "${args.account}". Make sure the account name is correct.`
                    }],
                    isError: false
                  };
                } else {
                  const mailboxes = await mailModule.getMailboxes();
                  return {
                    content: [{ 
                      type: "text", 
                      text: mailboxes.length > 0 ? 
                        `Found ${mailboxes.length} mailboxes:\n\n${mailboxes.join("\n")}` :
                        "No mailboxes found. Make sure Mail app is running and properly configured."
                    }],
                    isError: false
                  };
                }
              }

              case "accounts": {
                const accounts = await mailModule.getAccounts();
                return {
                  content: [{ 
                    type: "text", 
                    text: accounts.length > 0 ? 
                      `Found ${accounts.length} email accounts:\n\n${accounts.join("\n")}` :
                      "No email accounts found. Make sure Mail app is configured with at least one account."
                  }],
                  isError: false
                };
              }

              default:
                throw new Error(`Unknown operation: ${args.operation}`);
            }
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `Error with mail operation: ${error instanceof Error ? error.message : String(error)}`
              }],
              isError: true
            };
          }
        }

        case "reminders": {
          if (!isRemindersArgs(args)) {
            throw new Error("Invalid arguments for reminders tool");
          }

          try {
            const remindersModule = await loadModule('reminders');
            
            const { operation } = args;

            if (operation === "list") {
              // List all reminders
              const lists = await remindersModule.getAllLists();
              const allReminders = await remindersModule.getAllReminders();
              return {
                content: [{
                  type: "text",
                  text: `Found ${lists.length} lists and ${allReminders.length} reminders.`
                }],
                lists,
                reminders: allReminders,
                isError: false
              };
            } 
            else if (operation === "search") {
              // Search for reminders
              const { searchText } = args;
              const results = await remindersModule.searchReminders(searchText!);
              return {
                content: [{
                  type: "text",
                  text: results.length > 0 
                    ? `Found ${results.length} reminders matching "${searchText}".` 
                    : `No reminders found matching "${searchText}".`
                }],
                reminders: results,
                isError: false
              };
            } 
            else if (operation === "open") {
              // Open a reminder
              const { searchText } = args;
              const result = await remindersModule.openReminder(searchText!);
              return {
                content: [{
                  type: "text",
                  text: result.success 
                    ? `Opened Reminders app. Found reminder: ${result.reminder?.name}` 
                    : result.message
                }],
                ...result,
                isError: !result.success
              };
            } 
            else if (operation === "create") {
              // Create a reminder
              const { name, listName, notes, dueDate } = args;
              const result = await remindersModule.createReminder(name!, listName, notes, dueDate);
              return {
                content: [{
                  type: "text",
                  text: `Created reminder "${result.name}" ${listName ? `in list "${listName}"` : ''}.`
                }],
                success: true,
                reminder: result,
                isError: false
              };
            }
            else if (operation === "listById") {
              // Get reminders from a specific list by ID
              const { listId, props } = args;
              const results = await remindersModule.getRemindersFromListById(listId!, props);
              return {
                content: [{
                  type: "text",
                  text: results.length > 0 
                    ? `Found ${results.length} reminders in list with ID "${listId}".` 
                    : `No reminders found in list with ID "${listId}".`
                }],
                reminders: results,
                isError: false
              };
            }

            return {
              content: [{
                type: "text",
                text: "Unknown operation"
              }],
              isError: true
            };
          } catch (error) {
            console.error("Error in reminders tool:", error);
            return {
              content: [{
                type: "text",
                text: `Error in reminders tool: ${error}`
              }],
              isError: true
            };
          }
        }

        case "webSearch": {
          if (!isWebSearchArgs(args)) {
            throw new Error("Invalid arguments for web search tool");
          }

          const webSearchModule = await loadModule('webSearch');
          const result = await webSearchModule.webSearch(args.query);
          return {
            content: [{
              type: "text",
              text: result.results.length > 0 ? 
                `Found ${result.results.length} results for "${args.query}". ${result.results.map(r => `[${r.displayUrl}] ${r.title} - ${r.snippet} \n content: ${r.content}`).join("\n")}` : 
                `No results found for "${args.query}".`
            }],
            isError: false
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Start the server transport
  console.error("Setting up MCP server transport...");

  (async () => {
    try {
      console.error("Initializing transport...");
      const transport = new StdioServerTransport();

      // Ensure stdout is only used for JSON messages
      console.error("Setting up stdout filter...");
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
        // Only allow JSON messages to pass through
        if (typeof chunk === "string" && !chunk.startsWith("{")) {
          console.error("Filtering non-JSON stdout message");
          return true; // Silently skip non-JSON messages
        }
        return originalStdoutWrite(chunk, encoding, callback);
      };

      console.error("Connecting transport to server...");
      await server.connect(transport);
      console.error("Server connected successfully!");
    } catch (error) {
      console.error("Failed to initialize MCP server:", error);
      process.exit(1);
    }
  })();
}

// Helper functions for argument type checking
function isContactsArgs(args: unknown): args is { name?: string } {
  return (
    typeof args === "object" &&
    args !== null &&
    (!("name" in args) || typeof (args as { name: string }).name === "string")
  );
}

function isNotesArgs(args: unknown): args is { searchText?: string } {
  return (
    typeof args === "object" &&
    args !== null &&
    (!("searchText" in args) || typeof (args as { searchText: string }).searchText === "string")
  );
}

function isMessagesArgs(args: unknown): args is {
  operation: "send" | "read" | "schedule" | "unread";
  phoneNumber?: string;
  message?: string;
  limit?: number;
  scheduledTime?: string;
} {
  if (typeof args !== "object" || args === null) return false;
  
  const { operation, phoneNumber, message, limit, scheduledTime } = args as any;
  
  if (!operation || !["send", "read", "schedule", "unread"].includes(operation)) {
    return false;
  }
  
  // Validate required fields based on operation
  switch (operation) {
    case "send":
    case "schedule":
      if (!phoneNumber || !message) return false;
      if (operation === "schedule" && !scheduledTime) return false;
      break;
    case "read":
      if (!phoneNumber) return false;
      break;
    case "unread":
      // No additional required fields
      break;
  }
  
  // Validate field types if present
  if (phoneNumber && typeof phoneNumber !== "string") return false;
  if (message && typeof message !== "string") return false;
  if (limit && typeof limit !== "number") return false;
  if (scheduledTime && typeof scheduledTime !== "string") return false;
  
  return true;
}

function isMailArgs(args: unknown): args is {
  operation: "unread" | "search" | "send" | "mailboxes" | "accounts";
  account?: string;
  mailbox?: string;
  limit?: number;
  searchTerm?: string;
  to?: string;
  subject?: string;
  body?: string;
  cc?: string;
  bcc?: string;
} {
  if (typeof args !== "object" || args === null) return false;
  
  const { operation, account, mailbox, limit, searchTerm, to, subject, body, cc, bcc } = args as any;
  
  if (!operation || !["unread", "search", "send", "mailboxes", "accounts"].includes(operation)) {
    return false;
  }
  
  // Validate required fields based on operation
  switch (operation) {
    case "search":
      if (!searchTerm || typeof searchTerm !== "string") return false;
      break;
    case "send":
      if (!to || typeof to !== "string" || 
          !subject || typeof subject !== "string" || 
          !body || typeof body !== "string") return false;
      break;
    case "unread":
    case "mailboxes":
    case "accounts":
      // No additional required fields
      break;
  }
  
  // Validate field types if present
  if (account && typeof account !== "string") return false;
  if (mailbox && typeof mailbox !== "string") return false;
  if (limit && typeof limit !== "number") return false;
  if (cc && typeof cc !== "string") return false;
  if (bcc && typeof bcc !== "string") return false;
  
  return true;
}

function isRemindersArgs(args: unknown): args is {
  operation: "list" | "search" | "open" | "create" | "listById";
  searchText?: string;
  name?: string;
  listName?: string;
  listId?: string;
  props?: string[];
  notes?: string;
  dueDate?: string;
} {
  if (typeof args !== "object" || args === null) {
    return false;
  }

  const { operation } = args as any;
  if (typeof operation !== "string") {
    return false;
  }

  if (!["list", "search", "open", "create", "listById"].includes(operation)) {
    return false;
  }

  // For search and open operations, searchText is required
  if ((operation === "search" || operation === "open") && 
      (typeof (args as any).searchText !== "string" || (args as any).searchText === "")) {
    return false;
  }

  // For create operation, name is required
  if (operation === "create" && 
      (typeof (args as any).name !== "string" || (args as any).name === "")) {
    return false;
  }
  
  // For listById operation, listId is required
  if (operation === "listById" && 
      (typeof (args as any).listId !== "string" || (args as any).listId === "")) {
    return false;
  }

  return true;
}

function isWebSearchArgs(args: unknown): args is WebSearchArgs {
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as WebSearchArgs).query === "string"
  );
}