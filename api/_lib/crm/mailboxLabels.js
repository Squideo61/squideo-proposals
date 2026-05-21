// Pure mapping from a high-level mailbox action to the Gmail label mutation it
// performs. Kept dependency-free (no DB, no fetch) so it can be unit-tested
// without pulling in the Gmail API client. Consumed by mailbox.js.
//
// Returns one of:
//   { trash: true } / { untrash: true } — handled by messages.trash/untrash
//   { add: [...], remove: [...] }        — applied via messages.batchModify
//   null                                 — unknown action
export function actionToLabels(action) {
  switch (action) {
    case 'archive':    return { remove: ['INBOX'] };
    case 'markRead':   return { remove: ['UNREAD'] };
    case 'markUnread': return { add: ['UNREAD'] };
    case 'star':       return { add: ['STARRED'] };
    case 'unstar':     return { remove: ['STARRED'] };
    case 'spam':       return { add: ['SPAM'], remove: ['INBOX'] };
    case 'unspam':     return { remove: ['SPAM'], add: ['INBOX'] };
    case 'trash':      return { trash: true };
    case 'untrash':    return { untrash: true };
    default:           return null;
  }
}
