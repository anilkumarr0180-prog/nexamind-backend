import type { Types } from "mongoose";


export const ATTACHMENT_TYPES = {
  IMAGE: "IMAGE",
  DOCUMENT: "DOCUMENT",
} as const;

export type AttachmentType =
  (typeof ATTACHMENT_TYPES)[keyof typeof ATTACHMENT_TYPES];

export const ATTACHMENT_STATUSES = {
  PENDING: "PENDING",
  READY: "READY",
  FAILED: "FAILED",
} as const;

export type AttachmentStatus =
  (typeof ATTACHMENT_STATUSES)[keyof typeof ATTACHMENT_STATUSES];

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AllowedImageMimeType =
  (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export const ALLOWED_IMAGE_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
] as const;

/**
 * 10MB maximum file size limit for image attachments
 */

export const ALLOWED_DOCUMENT_EXTENSIONS = [
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".pdf",
  ".docx",
] as const;

export type AllowedDocumentExtension =
  (typeof ALLOWED_DOCUMENT_EXTENSIONS)[number];

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "application/json",
  "text/json",
  "text/csv",
  "application/csv",
  "application/pdf",
  "application/x-pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/docx",
] as const;

export type AllowedDocumentMimeType =
  (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

/**
 * 5MB maximum file size limit for documents (DOCX, PDF, TXT, MD, JSON, CSV)
 */
export const MAX_DOCUMENT_FILE_SIZE = 5 * 1024 * 1024;

/**
 * 50 pages maximum page limit for PDF documents
 */
export const MAX_PDF_PAGES = 50;

/**
 * 100,000 characters maximum extracted text limit for documents
 */
export const MAX_DOCUMENT_EXTRACTED_CHARS = 100_000;

export const MAX_ATTACHMENT_FILE_SIZE = 10 * 1024 * 1024;

export interface IAttachment {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  conversationId: Types.ObjectId;
  type: AttachmentType;
  originalName: string;
  mimeType: string;
  size: number;
  cloudinaryPublicId: string;
  secureUrl: string;
  status: AttachmentStatus;
  width?: number | null | undefined;
  height?: number | null | undefined;
  format?: string | null | undefined;
  extractedText?: string | null | undefined;
  extractedTextLength?: number | null | undefined;
  createdAt: Date;
  updatedAt: Date;
}

export type CreateAttachmentData = {
  userId: string | Types.ObjectId;
  conversationId: string | Types.ObjectId;
  type?: AttachmentType | undefined;
  originalName: string;
  mimeType: string;
  size: number;
  cloudinaryPublicId: string;
  secureUrl: string;
  status?: AttachmentStatus | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
  format?: string | null | undefined;
  extractedText?: string | null | undefined;
  extractedTextLength?: number | null | undefined;
};

export type UpdateAttachmentData = {
  status?: AttachmentStatus | undefined;
  cloudinaryPublicId?: string | undefined;
  secureUrl?: string | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
  format?: string | null | undefined;
};

export interface ValidateImageMetadataInput {
  originalName: string;
  mimeType: string;
  size: number;
}

export interface ValidatedImageMetadata {
  originalName: string;
  mimeType: AllowedImageMimeType;
  size: number;
}

export interface AttachmentUploadResponse {
  attachmentId: string;
  originalName: string;
  mimeType: string;
  size: number;
  secureUrl: string;
  status: AttachmentStatus;
}



export interface ValidateDocumentMetadataInput {
  originalName: string;
  mimeType: string;
  size: number;
}

export interface ValidatedDocumentMetadata {
  originalName: string;
  mimeType: string;
  size: number;
  extension: AllowedDocumentExtension;
}

export interface DocumentUploadResponse {
  attachmentId: string;
  type: AttachmentType;
  originalName: string;
  mimeType: string;
  size: number;
  secureUrl: string;
  status: AttachmentStatus;
  extractedTextLength: number;
}
