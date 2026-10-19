import "dotenv/config";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { Conversation } from "../src/modules/conversations/conversation.model.js";
import { Message } from "../src/modules/messages/message.model.js";
import { Attachment } from "../src/modules/attachments/attachment.model.js";

/**
 * Mask MongoDB connection string credentials for safe logging.
 */
function maskMongoUri(uri: string): string {
  try {
    return uri.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)([^@]+)(@.+)/i, "$1****$3");
  } catch {
    return "mongodb://[MASKED]";
  }
}

/**
 * Read-only assessment of historical orphaned messages and attachments
 * associated with soft-deleted conversations.
 * 
 * SAFETY INVARIANTS:
 * - Read-only: executes only .countDocuments(), .find(), and .aggregate().
 * - Rejects execution in production environment.
 * - Modifies ZERO records.
 */
async function assessOrphanedData() {
  console.log("================================================================================");
  console.log("       NEXAMIND DATA LIFECYCLE: ORPHANED MESSAGE DRY-RUN ASSESSMENT            ");
  console.log("================================================================================");

  // 1. Guard against production execution
  if (process.env.NODE_ENV === "production") {
    console.error("\n[SAFETY BLOCK] Refusing to run assessment in PRODUCTION mode.");
    console.error("Please run against a local or development database environment.\n");
    process.exit(1);
  }

  const rawUri = process.env.MONGODB_TEST_URI || process.env.MONGODB_URI;
  if (!rawUri) {
    console.error("\n[ERROR] No MONGODB_URI or MONGODB_TEST_URI found in environment.\n");
    process.exit(1);
  }

  console.log(`Environment:          ${process.env.NODE_ENV || "development"}`);
  console.log(`Database Target:      ${maskMongoUri(rawUri)}`);
  console.log(`Mode:                 READ-ONLY DRY RUN (No writes or deletes permitted)`);
  console.log("--------------------------------------------------------------------------------\n");

  await connectDatabase();

  try {
    // 2. Query total and soft-deleted conversations
    const [totalConversations, softDeletedCount] = await Promise.all([
      Conversation.countDocuments({}),
      Conversation.countDocuments({ deletedAt: { $ne: null } }),
    ]);

    console.log(`Total Conversations in DB:        ${totalConversations}`);
    console.log(`Soft-Deleted Conversations:       ${softDeletedCount}`);

    if (softDeletedCount === 0) {
      console.log("\n✓ No soft-deleted conversations exist in this database.");
      console.log("================================================================================");
      return;
    }

    // 3. Find all soft-deleted conversation IDs
    const softDeletedConversations = await Conversation.find({
      deletedAt: { $ne: null },
    })
      .select("_id title deletedAt messageCount")
      .lean();

    const softDeletedIds = softDeletedConversations.map((c) => c._id);

    // 4. Group remaining messages by conversationId for soft-deleted conversations
    const orphanedMessagesAggregation = await Message.aggregate([
      {
        $match: {
          conversationId: { $in: softDeletedIds },
        },
      },
      {
        $group: {
          _id: "$conversationId",
          messageCount: { $sum: 1 },
        },
      },
    ]);

    const convWithOrphansCount = orphanedMessagesAggregation.length;
    const totalOrphanedMessages = orphanedMessagesAggregation.reduce(
      (sum, item) => sum + item.messageCount,
      0,
    );

    // 5. Check if any soft-deleted conversations still have attachment records
    const orphanedAttachmentsCount = await Attachment.countDocuments({
      conversationId: { $in: softDeletedIds },
    });

    console.log(`Soft-Deleted Convs with Messages: ${convWithOrphansCount} (of ${softDeletedCount})`);
    console.log(`Total Remaining Message Docs:     ${totalOrphanedMessages}`);
    console.log(`Total Remaining Attachment Docs:  ${orphanedAttachmentsCount}`);

    if (convWithOrphansCount > 0) {
      console.log("\nBreakdown of Sample Soft-Deleted Conversations with Remaining Messages:");
      for (const item of orphanedMessagesAggregation.slice(0, 5)) {
        const matchingConv = softDeletedConversations.find(
          (c) => c._id.toString() === item._id.toString(),
        );
        console.log(
          `  - Conversation ID: ${item._id} | Messages: ${item.messageCount} | DeletedAt: ${matchingConv?.deletedAt?.toISOString() || "unknown"}`,
        );
      }
      if (convWithOrphansCount > 5) {
        console.log(`  ... and ${convWithOrphansCount - 5} more soft-deleted conversations.`);
      }
    } else {
      console.log("\n✓ All soft-deleted conversations have 0 remaining message documents.");
    }

    console.log("\n================================================================================");
    console.log(" ASSESSMENT COMPLETE: 0 RECORDS MODIFIED OR DELETED (READ-ONLY CONFIRMED)");
    console.log("================================================================================");
  } finally {
    await disconnectDatabase();
  }
}

assessOrphanedData().catch((err) => {
  console.error("\n[Assessment Error]:", err);
  process.exit(1);
});
