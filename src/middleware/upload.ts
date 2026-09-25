import multer from "multer";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { AppError } from "../errors/app.error.js";
import {
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_FILE_SIZE,
  ALLOWED_DOCUMENT_EXTENSIONS,
  ALLOWED_DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_FILE_SIZE,
} from "../modules/attachments/attachment.types.js";

const storage = multer.memoryStorage();

const multerUpload = multer({
  storage,
  limits: {
    fileSize: MAX_ATTACHMENT_FILE_SIZE,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const hasValidExt = (ALLOWED_IMAGE_EXTENSIONS as readonly string[]).includes(ext);
    const hasValidMime = (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.mimetype.toLowerCase());

    if (!hasValidExt || !hasValidMime) {
      return cb(
        new AppError(
          "Invalid MIME type. Only JPG, JPEG, PNG, and WEBP images are supported",
          400,
          "INVALID_MIME_TYPE",
        ),
      );
    }

    cb(null, true);
  },
});

/**
 * Middleware for parsing multipart/form-data with exactly one image file.
 * Normalizes files from field names 'file' or 'image' and validates constraints strictly.
 */
export const uploadSingleImage = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  multerUpload.any()(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return next(
            new AppError(
              `File size exceeds maximum allowed limit of ${MAX_ATTACHMENT_FILE_SIZE / (1024 * 1024)}MB`,
              400,
              "FILE_TOO_LARGE",
            ),
          );
        }

        if (
          err.code === "LIMIT_FILE_COUNT" ||
          err.code === "LIMIT_UNEXPECTED_FILE"
        ) {
          return next(
            new AppError(
              "Only exactly one image file is allowed",
              400,
              "TOO_MANY_FILES",
            ),
          );
        }

        return next(new AppError(err.message, 400, "INVALID_UPLOAD"));
      }

      if (err instanceof AppError) {
        return next(err);
      }

      return next(err);
    }

    const files = req.files as Express.Multer.File[] | undefined;

    if (!files || files.length === 0) {
      return next(
        new AppError("Image file is required", 400, "MISSING_FILE"),
      );
    }

    if (files.length > 1) {
      return next(
        new AppError(
          "Only exactly one image file is allowed",
          400,
          "TOO_MANY_FILES",
        ),
      );
    }

    const singleFile = files[0]!;
    if (singleFile.fieldname !== "file" && singleFile.fieldname !== "image") {
      return next(
        new AppError(
          "Image file must be provided in field 'file' or 'image'",
          400,
          "INVALID_FILE_FIELD",
        ),
      );
    }

    req.file = singleFile;
    return next();
  });
};


const multerDocUpload = multer({
  storage,
  limits: {
    fileSize: MAX_DOCUMENT_FILE_SIZE,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const hasValidExt = (ALLOWED_DOCUMENT_EXTENSIONS as readonly string[]).includes(ext);
    const mime = file.mimetype.toLowerCase();
    const hasValidMime =
      (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(mime) ||
      mime.startsWith("text/") ||
      mime === "application/json" ||
      mime === "application/csv" ||
      mime === "application/pdf" ||
      mime === "application/x-pdf" ||
      mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      mime === "application/docx";

    if (!hasValidExt || !hasValidMime) {
      return cb(
        new AppError(
          "Invalid document type. Only DOCX, PDF, TXT, MD, JSON, and CSV documents are supported",
          400,
          "INVALID_MIME_TYPE",
        ),
      );
    }

    cb(null, true);
  },
});

/**
 * Middleware for parsing multipart/form-data with exactly one text-based document file (.txt, .md, .json, .csv).
 * Normalizes files from field names "file" or "document" and validates constraints strictly.
 */
export const uploadSingleDocument = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  multerDocUpload.any()(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return next(
            new AppError(
              `File size exceeds maximum allowed limit of ${MAX_DOCUMENT_FILE_SIZE / (1024 * 1024)}MB`,
              400,
              "FILE_TOO_LARGE",
            ),
          );
        }

        if (
          err.code === "LIMIT_FILE_COUNT" ||
          err.code === "LIMIT_UNEXPECTED_FILE"
        ) {
          return next(
            new AppError(
              "Only exactly one document file is allowed",
              400,
              "TOO_MANY_FILES",
            ),
          );
        }

        return next(new AppError(err.message, 400, "INVALID_UPLOAD"));
      }

      if (err instanceof AppError) {
        return next(err);
      }

      return next(err);
    }

    const files = req.files as Express.Multer.File[] | undefined;

    if (!files || files.length === 0) {
      return next(
        new AppError("Document file is required", 400, "MISSING_FILE"),
      );
    }

    if (files.length > 1) {
      return next(
        new AppError(
          "Only exactly one document file is allowed",
          400,
          "TOO_MANY_FILES",
        ),
      );
    }

    const singleFile = files[0]!;
    if (singleFile.fieldname !== "file" && singleFile.fieldname !== "document") {
      return next(
        new AppError(
          "Document file must be provided in field 'file' or 'document'",
          400,
          "INVALID_FILE_FIELD",
        ),
      );
    }

    req.file = singleFile;
    return next();
  });
};
