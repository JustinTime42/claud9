/**
 * Splits a message into chunks that fit within Discord's 2000-character limit.
 * Respects code block boundaries so formatting isn't broken across chunks.
 */
export function chunkMessage(text: string, maxLength: number = 1900): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = maxLength;

    // Try to split at a code block boundary
    const codeBlockEnd = remaining.lastIndexOf("\n```", splitIndex);
    if (codeBlockEnd > maxLength * 0.3) {
      // Check if there's a closing ``` — split after it
      const afterBlock = remaining.indexOf("\n", codeBlockEnd + 4);
      if (afterBlock !== -1 && afterBlock <= splitIndex) {
        splitIndex = afterBlock + 1;
      } else {
        splitIndex = codeBlockEnd;
      }
    } else {
      // Try to split at a newline
      const lastNewline = remaining.lastIndexOf("\n", splitIndex);
      if (lastNewline > maxLength * 0.3) {
        splitIndex = lastNewline + 1;
      }
      // Otherwise split at space
      else {
        const lastSpace = remaining.lastIndexOf(" ", splitIndex);
        if (lastSpace > maxLength * 0.3) {
          splitIndex = lastSpace + 1;
        }
        // Hard split as last resort
      }
    }

    const chunk = remaining.slice(0, splitIndex);
    chunks.push(chunk);
    remaining = remaining.slice(splitIndex);

    // If we split inside a code block, re-open it in the next chunk
    const openBlocks = (chunk.match(/```/g) || []).length;
    if (openBlocks % 2 !== 0) {
      // Find the language tag of the last opened block
      const lastOpen = chunk.lastIndexOf("```");
      const afterTicks = chunk.slice(lastOpen + 3);
      const langMatch = afterTicks.match(/^(\w+)/);
      const lang = langMatch ? langMatch[1] : "";

      // Close the block in the current chunk
      chunks[chunks.length - 1] += "\n```";
      // Re-open in the next chunk
      remaining = "```" + lang + "\n" + remaining;
    }
  }

  return chunks.filter((c) => c.trim().length > 0);
}
