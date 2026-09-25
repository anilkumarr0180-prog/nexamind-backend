import path from "node:path";
import { AppError } from "../../errors/app.error.js";
import {
  findConversationById,
} from "../conversations/conversation.repository.js";
import { CONVERSATION_STATUSES } from "../conversations/conversation.model.js";
import type { Types } from "mongoose";
import { Message } from "../messages/message.model.js";
import {
  deleteImageFromCloudinary,
  deleteFileFromCloudinary,
  uploadImageToCloudinary,
  uploadDocumentToCloudinary,
} from "../../config/cloudinary.js";
import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";
import * as attachmentRepository from "./attachment.repository.js";
import {
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_IMAGE_MIME_TYPES,
  ATTACHMENT_STATUSES,
  ATTACHMENT_TYPES,
  MAX_ATTACHMENT_FILE_SIZE,
  ALLOWED_DOCUMENT_EXTENSIONS,
  ALLOWED_DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_FILE_SIZE,
  MAX_PDF_PAGES,
  MAX_DOCUMENT_EXTRACTED_CHARS,
  type AllowedDocumentExtension,
  type DocumentUploadResponse,
  type ValidateDocumentMetadataInput,
  type ValidatedDocumentMetadata,
  type AllowedImageMimeType,
  type AttachmentStatus,
  type AttachmentUploadResponse,
  type IAttachment,
  type ValidateImageMetadataInput,
  type ValidatedImageMetadata,
} from "./attachment.types.js";

/**
 * Validates image metadata strictly:
 * - Only JPG, JPEG, PNG, and WEBP formats
 * - Reasonable file size limit (10MB max, > 0 bytes)
 */
export const validateImageMetadata = (
  input: ValidateImageMetadataInput,
): ValidatedImageMetadata => {
  const trimmedName = input.originalName?.trim();

  if (!trimmedName || trimmedName.length === 0) {
    throw new AppError("File name is required", 400, "INVALID_FILE_NAME");
  }

  if (trimmedName.length > 255) {
    throw new AppError("File name exceeds maximum length of 255 characters", 400, "INVALID_FILE_NAME");
  }

  const ext = path.extname(trimmedName).toLowerCase();
  const hasValidExtension = (ALLOWED_IMAGE_EXTENSIONS as readonly string[]).includes(ext);

  if (!hasValidExtension) {
    throw new AppError(
      "Only JPG, JPEG, PNG, and WEBP image files are allowed",
      400,
      "INVALID_MIME_TYPE",
    );
  }

  const normalizedMime = input.mimeType?.trim().toLowerCase();
  const isValidMime = (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(normalizedMime);

  if (!isValidMime) {
    throw new AppError(
      "Invalid MIME type. Only JPG, JPEG, PNG, and WEBP images are supported",
      400,
      "INVALID_MIME_TYPE",
    );
  }

  if (typeof input.size !== "number" || Number.isNaN(input.size) || input.size <= 0) {
    throw new AppError("File cannot be empty", 400, "INVALID_FILE_SIZE");
  }

  if (input.size > MAX_ATTACHMENT_FILE_SIZE) {
    throw new AppError(
      `File size exceeds maximum allowed limit of ${MAX_ATTACHMENT_FILE_SIZE / (1024 * 1024)}MB`,
      400,
      "FILE_TOO_LARGE",
    );
  }

  return {
    originalName: trimmedName,
    mimeType: normalizedMime as AllowedImageMimeType,
    size: input.size,
  };
};

/**
 * Strictly verifies authenticated user and conversation ownership:
 * - Authenticated user required
 * - Conversation must exist
 * - Conversation must belong to the authenticated user
 * - Archived conversations cannot accept attachments
 */
export const verifyConversationOwnership = async (
  userId: string,
  conversationId: string,
) => {
  const trimmedUserId = userId?.trim();
  if (!trimmedUserId || trimmedUserId.length === 0) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const trimmedConversationId = conversationId?.trim();
  if (!trimmedConversationId || trimmedConversationId.length === 0) {
    throw new AppError("Conversation ID is required", 400, "INVALID_INPUT");
  }

  const conversation = await findConversationById(trimmedConversationId);

  if (!conversation) {
    throw new AppError("Conversation not found", 404, "CONVERSATION_NOT_FOUND");
  }

  if (conversation.userId.toString() !== trimmedUserId) {
    throw new AppError(
      "Conversation does not belong to the authenticated user",
      403,
      "FORBIDDEN",
    );
  }

  if (conversation.status === CONVERSATION_STATUSES.ARCHIVED) {
    throw new AppError(
      "Archived conversations cannot accept attachments",
      400,
      "CONVERSATION_ARCHIVED",
    );
  }

  return conversation;
};

export interface CreateAttachmentMetadataInput {
  userId: string;
  conversationId: string;
  originalName: string;
  mimeType: string;
  size: number;
  cloudinaryPublicId: string;
  secureUrl: string;
  status?: AttachmentStatus | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
  format?: string | null | undefined;
}

/**
 * Creates and stores attachment metadata in the database after strict ownership
 * and metadata validation.
 */

/**
 * Validates document metadata strictly:
 * - Only TXT, MD, JSON, and CSV extensions
 * - Enforces MAX_DOCUMENT_FILE_SIZE (2MB max, > 0 bytes)
 */
export const validateDocumentMetadata = (
  input: ValidateDocumentMetadataInput,
): ValidatedDocumentMetadata => {
  const trimmedName = input.originalName?.trim();
  if (!trimmedName || trimmedName.length === 0) {
    throw new AppError("Document file name is required", 400, "INVALID_FILENAME");
  }

  const ext = path.extname(trimmedName).toLowerCase();
  const hasValidExt = (ALLOWED_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext);

  if (!hasValidExt) {
    throw new AppError(
      "Invalid document extension. Supported extensions are: .docx, .pdf, .txt, .md, .json, .csv",
      400,
      "INVALID_MIME_TYPE",
    );
  }

  const mime = (input.mimeType || "").toLowerCase().trim();
  const hasValidMime =
    (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(mime as any) ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/csv" ||
    mime === "application/pdf" ||
    mime === "application/x-pdf" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/docx";

  if (!hasValidMime) {
    throw new AppError(
      "Invalid document type. Only DOCX, PDF, TXT, MD, JSON, and CSV documents are supported",
      400,
      "INVALID_MIME_TYPE",
    );
  }

  if (typeof input.size !== "number" || Number.isNaN(input.size) || input.size <= 0) {
    throw new AppError("File cannot be empty", 400, "EMPTY_FILE");
  }

  if (input.size > MAX_DOCUMENT_FILE_SIZE) {
    throw new AppError(
      `File size exceeds maximum allowed limit of ${MAX_DOCUMENT_FILE_SIZE / (1024 * 1024)}MB`,
      400,
      "FILE_TOO_LARGE",
    );
  }

  return {
    originalName: trimmedName,
    mimeType: mime,
    size: input.size,
    extension: ext as AllowedDocumentExtension,
  };
};

/**
 * Extracts plain text from document buffer and strictly validates structure.
 * - JSON documents are parsed/validated; invalid JSON fails safely.
 * - CSV and Markdown are treated as text content without execution.
 * - Binary / null-byte content fails safely.
 */
export const extractDocumentText = async (
  bufferOrString: Buffer | string,
  extension: AllowedDocumentExtension,
): Promise<string> => {
  if (extension === ".docx") {
    let buffer: Buffer;
    if (Buffer.isBuffer(bufferOrString)) {
      buffer = bufferOrString;
    } else if (typeof bufferOrString === "string") {
      buffer = Buffer.from(bufferOrString, "binary");
    } else {
      throw new AppError("Invalid DOCX content", 400, "INVALID_DOCX");
    }

    let extractionResult;
    try {
      extractionResult = await mammoth.extractRawText({ buffer });
    } catch (parseErr: unknown) {
      throw new AppError(
        "Failed to extract text from DOCX: invalid or corrupted DOCX file",
        400,
        "INVALID_DOCX",
      );
    }

    const rawText = (extractionResult.value ?? "").trim();
    if (rawText.length === 0) {
      throw new AppError(
        "No readable text could be extracted from this DOCX document. Empty documents or documents containing only images are not supported.",
        400,
        "UNPROCESSABLE_DOCX",
      );
    }

    if (rawText.length > MAX_DOCUMENT_EXTRACTED_CHARS) {
      return rawText.slice(0, MAX_DOCUMENT_EXTRACTED_CHARS);
    }

    return rawText;
  }

  if (extension === ".pdf") {
    let uint8Array: Uint8Array;
    if (Buffer.isBuffer(bufferOrString)) {
      uint8Array = new Uint8Array(
        bufferOrString.buffer,
        bufferOrString.byteOffset,
        bufferOrString.byteLength,
      );
    } else if (typeof bufferOrString === "string") {
      uint8Array = new Uint8Array(Buffer.from(bufferOrString, "binary"));
    } else {
      throw new AppError("Invalid PDF content", 400, "INVALID_PDF");
    }

    let pdf;
    try {
      pdf = await getDocumentProxy(uint8Array);
    } catch {
      throw new AppError(
        "Failed to extract text from PDF: invalid or corrupted PDF file",
        400,
        "INVALID_PDF",
      );
    }

    if (pdf.numPages > MAX_PDF_PAGES) {
      throw new AppError(
        `PDF exceeds maximum allowed page count of ${MAX_PDF_PAGES} pages (found ${pdf.numPages} pages)`,
        400,
        "PDF_TOO_MANY_PAGES",
      );
    }

    let textResult;
    try {
      textResult = await extractText(pdf, { mergePages: true });
    } catch {
      throw new AppError(
        "Failed to extract text from PDF",
        400,
        "TEXT_EXTRACTION_FAILED",
      );
    }

    const rawText = (textResult.text ?? "").trim();
    if (rawText.length === 0) {
      throw new AppError(
        "No readable text could be extracted from this PDF. Scanned or image-only PDFs are not currently supported.",
        400,
        "UNPROCESSABLE_PDF",
      );
    }

    if (rawText.length > MAX_DOCUMENT_EXTRACTED_CHARS) {
      return rawText.slice(0, MAX_DOCUMENT_EXTRACTED_CHARS);
    }

    return rawText;
  }

  let text = "";
  if (typeof bufferOrString === "string") {
    text = bufferOrString;
  } else if (Buffer.isBuffer(bufferOrString)) {
    text = bufferOrString.toString("utf-8");
  } else {
    throw new AppError("Invalid file content", 400, "TEXT_EXTRACTION_FAILED");
  }

  // Reject binary content in plain-text documents
  if (text.includes("\0")) {
    throw new AppError(
      "Failed to extract text from document: binary or corrupted content detected",
      400,
      "TEXT_EXTRACTION_FAILED",
    );
  }

  // JSON must be parsed/validated before being accepted
  if (extension === ".json") {
    try {
      JSON.parse(text);
    } catch {
      throw new AppError("Invalid JSON document format", 400, "INVALID_JSON");
    }
  }

  if (text.length > MAX_DOCUMENT_EXTRACTED_CHARS) {
    return text.slice(0, MAX_DOCUMENT_EXTRACTED_CHARS);
  }

  return text;
};

export interface UploadDocumentAttachmentInput {
  userId: string;
  conversationId: string;
  file: Buffer | string;
  originalName: string;
  mimeType: string;
  size: number;
}

/**
 * End-to-end document attachment handler:
 * - Validates ownership and document metadata strictly
 * - Extracts and validates plain text content
 * - Uploads document to Cloudinary as raw resource
 * - Persists Attachment record with extracted text
 */
export const uploadDocumentAttachment = async (
  params: UploadDocumentAttachmentInput,
): Promise<DocumentUploadResponse> => {
  // 1. Verify user & conversation ownership
  await verifyConversationOwnership(params.userId, params.conversationId);

  // 2. Validate document metadata strictly
  const validated = validateDocumentMetadata({
    originalName: params.originalName,
    mimeType: params.mimeType,
    size: params.size,
  });

  // 3. Extract and validate text content
  const extractedText = await extractDocumentText(params.file, validated.extension);

  // 4. Upload raw document to Cloudinary
  const folder = `nexamind/users/${params.userId}/conversations/${params.conversationId}/documents`;
  const uploadResult = await uploadDocumentToCloudinary(params.file, {
    folder,
  });

  // 5. Persist Attachment record
  let attachment: IAttachment;
  try {
    attachment = await attachmentRepository.createAttachment({
      userId: params.userId,
      conversationId: params.conversationId,
      type: ATTACHMENT_TYPES.DOCUMENT,
      originalName: validated.originalName,
      mimeType: validated.mimeType,
      size: validated.size,
      cloudinaryPublicId: uploadResult.cloudinaryPublicId,
      secureUrl: uploadResult.secureUrl,
      status: ATTACHMENT_STATUSES.READY,
      format: validated.extension.replace(".", ""),
      extractedText,
      extractedTextLength: extractedText.length,
    });
  } catch (dbError) {
    try {
      await deleteFileFromCloudinary(uploadResult.cloudinaryPublicId, "raw");
    } catch (cleanupError) {
      console.error(
        "Failed to delete orphaned Cloudinary asset after MongoDB save failure:",
        cleanupError,
      );
    }
    throw dbError;
  }

  return {
    attachmentId: attachment._id.toString(),
    type: attachment.type,
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    secureUrl: attachment.secureUrl,
    status: attachment.status,
    extractedTextLength: attachment.extractedTextLength ?? 0,
  };
};

export const createAttachmentMetadata = async (
  params: CreateAttachmentMetadataInput,
): Promise<IAttachment> => {
  await verifyConversationOwnership(params.userId, params.conversationId);
  const validated = validateImageMetadata({
    originalName: params.originalName,
    mimeType: params.mimeType,
    size: params.size,
  });

  const cloudinaryPublicId = params.cloudinaryPublicId?.trim();
  const secureUrl = params.secureUrl?.trim();

  if (!cloudinaryPublicId || !secureUrl) {
    throw new AppError(
      "Cloudinary public ID and secure URL are required",
      400,
      "INVALID_CLOUDINARY_METADATA",
    );
  }

  return attachmentRepository.createAttachment({
    userId: params.userId,
    conversationId: params.conversationId,
    originalName: validated.originalName,
    mimeType: validated.mimeType,
    size: validated.size,
    cloudinaryPublicId,
    secureUrl,
    status: params.status ?? ATTACHMENT_STATUSES.READY,
    width: params.width ?? null,
    height: params.height ?? null,
    format: params.format ?? null,
  });
};

export interface UploadImageAttachmentInput {
  userId: string;
  conversationId: string;
  file: Buffer | string;
  originalName: string;
  mimeType: string;
  size: number;
}

/**
 * End-to-end attachment handler:
 * Validates ownership & metadata, uploads image to Cloudinary, and persists attachment record.
 */
export const uploadImageAttachment = async (
  params: UploadImageAttachmentInput,
): Promise<AttachmentUploadResponse> => {
  // 1. Verify user & conversation ownership BEFORE uploading to Cloudinary
  await verifyConversationOwnership(params.userId, params.conversationId);

  // 2. Validate image metadata strictly (type, extension, size)
  const validated = validateImageMetadata({
    originalName: params.originalName,
    mimeType: params.mimeType,
    size: params.size,
  });

  // 3. Upload to Cloudinary under the exact requested folder:
  // nexamind/users/{userId}/conversations/{conversationId}/images
  const folder = `nexamind/users/${params.userId}/conversations/${params.conversationId}/images`;
  const uploadResult = await uploadImageToCloudinary(params.file, {
    folder,
  });

  // 4. Save the Attachment metadata through repository with rollback if DB save fails
  let attachment: IAttachment;
  try {
    attachment = await attachmentRepository.createAttachment({
      userId: params.userId,
      conversationId: params.conversationId,
      originalName: validated.originalName,
      mimeType: validated.mimeType,
      size: validated.size,
      cloudinaryPublicId: uploadResult.cloudinaryPublicId,
      secureUrl: uploadResult.secureUrl,
      status: ATTACHMENT_STATUSES.READY,
      width: uploadResult.width ?? null,
      height: uploadResult.height ?? null,
      format: uploadResult.format ?? null,
    });
  } catch (dbError) {
    // If Cloudinary succeeds but MongoDB save fails, delete the Cloudinary asset to prevent orphaned files
    try {
      await deleteImageFromCloudinary(uploadResult.cloudinaryPublicId);
    } catch (cleanupError) {
      console.error(
        "Failed to delete orphaned Cloudinary asset after MongoDB save failure:",
        cleanupError,
      );
    }
    throw dbError;
  }

  // 5. Return strictly: attachmentId, originalName, mimeType, size, secureUrl, status
  return {
    attachmentId: attachment._id.toString(),
    originalName: attachment.originalName,
    mimeType: attachment.mimeType,
    size: attachment.size,
    secureUrl: attachment.secureUrl,
    status: attachment.status,
  };
};

/**
 * Retrieves an attachment by ID, enforcing user ownership.
 */
export const getAttachmentById = async (
  attachmentId: string,
  userId: string,
): Promise<IAttachment> => {
  const trimmedUserId = userId?.trim();
  if (!trimmedUserId || trimmedUserId.length === 0) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const attachment = await attachmentRepository.findAttachmentById(attachmentId);

  if (!attachment) {
    throw new AppError("Attachment not found", 404, "ATTACHMENT_NOT_FOUND");
  }

  if (attachment.userId.toString() !== trimmedUserId) {
    throw new AppError(
      "Attachment does not belong to the authenticated user",
      403,
      "FORBIDDEN",
    );
  }

  return attachment;
};

/**
 * Retrieves all attachments for a conversation, enforcing conversation ownership.
 */
export const getConversationAttachments = async (
  conversationId: string,
  userId: string,
): Promise<IAttachment[]> => {
  await verifyConversationOwnership(userId, conversationId);
  return attachmentRepository.findAttachmentsByConversationId(
    conversationId,
    userId,
  );
};

/**
 * Verifies an attachment exists, belongs to the authenticated user, and belongs
 * to the specified conversation before linking to a message.
 */
export const verifyAttachmentForMessage = async (
  attachmentId: string,
  userId: string,
  conversationId: string,
): Promise<IAttachment> => {
  const trimmedId = attachmentId?.trim();
  if (!trimmedId) {
    throw new AppError("Invalid attachment ID", 400, "INVALID_ATTACHMENT_ID");
  }

  const attachment = await attachmentRepository.findAttachmentById(trimmedId);

  if (!attachment) {
    throw new AppError("Attachment not found", 404, "ATTACHMENT_NOT_FOUND");
  }

  if (attachment.userId.toString() !== userId.trim()) {
    throw new AppError(
      "Attachment does not belong to the authenticated user",
      403,
      "FORBIDDEN",
    );
  }

  if (attachment.conversationId.toString() !== conversationId.trim()) {
    throw new AppError(
      "Attachment does not belong to this conversation",
      400,
      "INVALID_ATTACHMENT_CONVERSATION",
    );
  }

  // Verify processing/status is READY
  if (attachment.status !== ATTACHMENT_STATUSES.READY) {
    throw new AppError(
      `Attachment is not ready for use (status: ${attachment.status})`,
      400,
      "ATTACHMENT_NOT_READY",
    );
  }

  // If document attachment, verify it is a supported document type (.txt, .md, .json, .csv)
  if (attachment.type === ATTACHMENT_TYPES.DOCUMENT) {
    const ext = "." + (attachment.format || "").toLowerCase().replace(/^\./, "");
    const isSupportedExt = (ALLOWED_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext as any);
    const mime = (attachment.mimeType || "").toLowerCase().trim();
    const isSupportedMime =
      (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(mime as any) ||
      mime.startsWith("text/") ||
      mime === "application/json" ||
      mime === "application/csv" ||
      mime === "application/pdf" ||
      mime === "application/x-pdf" ||
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mime === "application/docx";

    if (!isSupportedExt && !isSupportedMime) {
      throw new AppError(
        "Unsupported document type. Only DOCX, PDF, TXT, MD, JSON, and CSV documents are supported",
        400,
        "UNSUPPORTED_DOCUMENT_TYPE",
      );
    }
  }

  return attachment;
};



export interface DeleteAttachmentOptions {
  force?: boolean | undefined;
}

export interface DeleteAttachmentResult {
  success: boolean;
  deleted: boolean;
  attachmentId: string;
}

/**
 * Permanently deletes an attachment:
 * - verifies authenticated user owns the attachment
 * - checks if referenced by any messages (unless force is true)
 * - deletes Cloudinary asset safely
 * - deletes MongoDB Attachment record
 * - idempotent (missing attachment returns gracefully without crashing)
 */
export const deleteAttachment = async (
  attachmentId: string,
  userId: string,
  options?: DeleteAttachmentOptions,
): Promise<DeleteAttachmentResult> => {
  const trimmedUserId = userId?.trim();
  if (!trimmedUserId) {
    throw new AppError("Authentication required", 401, "UNAUTHORIZED");
  }

  const trimmedId = attachmentId?.trim();
  if (!trimmedId) {
    throw new AppError("Invalid attachment ID", 400, "INVALID_ATTACHMENT_ID");
  }

  const attachment = await attachmentRepository.findAttachmentById(trimmedId);
  if (!attachment) {
    return {
      success: true,
      deleted: false,
      attachmentId: trimmedId,
    };
  }

  if (attachment.userId.toString() !== trimmedUserId) {
    throw new AppError(
      "Attachment does not belong to the authenticated user",
      403,
      "FORBIDDEN",
    );
  }

  // Handle edit/regenerate: check if referenced by any messages
  const isReferenced = await Message.exists({ attachmentId: attachment._id });
  if (isReferenced && !options?.force) {
    throw new AppError(
      "Cannot delete attachment because it is currently referenced by one or more messages",
      400,
      "ATTACHMENT_IN_USE",
    );
  }

  // Delete Cloudinary asset safely
  if (attachment.cloudinaryPublicId) {
    const resourceType = attachment.type === ATTACHMENT_TYPES.DOCUMENT ? "raw" : "image";
    try {
      await deleteFileFromCloudinary(attachment.cloudinaryPublicId, resourceType);
    } catch (cloudinaryErr) {
      console.warn(
        `[AttachmentService] Non-fatal Cloudinary cleanup error for ${attachment.cloudinaryPublicId}:`,
        cloudinaryErr,
      );
    }
  }

  // Delete MongoDB Attachment record
  await attachmentRepository.deleteAttachmentById(attachment._id);

  // If force deleting while messages reference it, nullify references to avoid dangling IDs
  if (isReferenced && options?.force) {
    try {
      await Message.updateMany(
        { attachmentId: attachment._id },
        { $set: { attachmentId: null } },
      );
    } catch (refErr) {
      console.warn("[AttachmentService] Failed to nullify message attachment references:", refErr);
    }
  }

  return {
    success: true,
    deleted: true,
    attachmentId: attachment._id.toString(),
  };
};

/**
 * Checks whether an attachment is still referenced by any message/version.
 * If orphaned (no messages reference it), permanently deletes Cloudinary asset and MongoDB record.
 * Returns true if cleaned up, false if still referenced.
 */
export const cleanupAttachmentIfOrphaned = async (
  attachmentId: string | Types.ObjectId,
  userId: string,
): Promise<boolean> => {
  const attIdStr = attachmentId.toString();
  const stillReferenced = await Message.exists({ attachmentId: attIdStr });
  if (stillReferenced) {
    return false;
  }

  const res = await deleteAttachment(attIdStr, userId, { force: true });
  return res.deleted;
};

/**
 * Permanently deletes all attachments belonging to a conversation:
 * - deletes Cloudinary assets safely
 * - deletes MongoDB Attachment records
 */
export const deleteConversationAttachments = async (
  conversationId: string,
  userId: string,
): Promise<number> => {
  const attachments = await attachmentRepository.findAttachmentsByConversationId(
    conversationId,
    userId,
  );

  if (attachments.length === 0) {
    return 0;
  }

  let deletedCount = 0;
  for (const att of attachments) {
    if (att.cloudinaryPublicId) {
      const resourceType = att.type === ATTACHMENT_TYPES.DOCUMENT ? "raw" : "image";
      try {
        await deleteFileFromCloudinary(att.cloudinaryPublicId, resourceType);
      } catch (err) {
        console.warn(
          `[AttachmentService] Non-fatal Cloudinary cleanup error for ${att.cloudinaryPublicId}:`,
          err,
        );
      }
    }

    await attachmentRepository.deleteAttachmentById(att._id);
    deletedCount++;
  }

  return deletedCount;
};
