import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";
import { env } from "./env.js";
import { AppError } from "../errors/app.error.js";

/**
 * Configure Cloudinary SDK with validated environment credentials.
 * Ensures secure HTTPS URLs by default.
 * API secret is kept secure and never logged.
 */
cloudinary.config({
  cloud_name: env.CLOUDINARY_CLOUD_NAME,
  api_key: env.CLOUDINARY_API_KEY,
  api_secret: env.CLOUDINARY_API_SECRET,
  secure: true,
});

export interface CloudinaryConfigInput {
  cloudName?: string | undefined;
  apiKey?: string | undefined;
  apiSecret?: string | undefined;
}

export interface CloudinaryImageUploadResult {
  cloudinaryPublicId: string;
  secureUrl: string;
  size: number;
  format: string;
  width?: number | undefined;
  height?: number | undefined;
}

export interface CloudinaryUploadOptions {
  folder?: string | undefined;
  publicId?: string | undefined;
  tags?: string[] | undefined;
}

/**
 * Validates Cloudinary credentials.
 * Never logs the API secret upon failure.
 */
export const validateCloudinaryConfig = (config: CloudinaryConfigInput): boolean => {
  if (!config.cloudName || config.cloudName.trim().length === 0) {
    throw new AppError(
      "Cloudinary cloud name is required",
      500,
      "INVALID_CLOUDINARY_CONFIG",
    );
  }

  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new AppError(
      "Cloudinary API key is required",
      500,
      "INVALID_CLOUDINARY_CONFIG",
    );
  }

  if (!config.apiSecret || config.apiSecret.trim().length === 0) {
    throw new AppError(
      "Cloudinary API secret is required",
      500,
      "INVALID_CLOUDINARY_CONFIG",
    );
  }

  return true;
};

/**
 * Safe inspection helper that returns public Cloudinary configuration.
 * Omit apiSecret to prevent accidental logging or exposure.
 */
export const getCloudinaryPublicConfig = () => {
  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    secure: true,
  };
};

/**
 * Uploads an image (Buffer, file path, or base64 data URI) directly to Cloudinary.
 * Exposes strictly image-only upload functionality with secure HTTPS result.
 */
export const uploadImageToCloudinary = async (
  input: Buffer | string,
  options?: CloudinaryUploadOptions,
): Promise<CloudinaryImageUploadResult> => {
  const uploadOptions: Record<string, unknown> = {
    resource_type: "image",
    folder: options?.folder ?? "nexamind/attachments",
    ...(options?.publicId ? { public_id: options.publicId } : {}),
    ...(options?.tags ? { tags: options.tags } : {}),
  };

  if (typeof input === "string") {
    try {
      const result: UploadApiResponse = await cloudinary.uploader.upload(
        input,
        uploadOptions,
      );

      return {
        cloudinaryPublicId: result.public_id,
        secureUrl: result.secure_url,
        size: result.bytes,
        format: result.format,
        ...(result.width !== undefined ? { width: result.width } : {}),
        ...(result.height !== undefined ? { height: result.height } : {}),
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Cloudinary upload failed";
      throw new AppError(
        `Failed to upload image to Cloudinary: ${message}`,
        502,
        "CLOUDINARY_UPLOAD_FAILED",
      );
    }
  }

  return new Promise<CloudinaryImageUploadResult>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error || !result) {
          return reject(
            new AppError(
              `Failed to upload image to Cloudinary: ${error?.message ?? "Upload failed"}`,
              502,
              "CLOUDINARY_UPLOAD_FAILED",
            ),
          );
        }

        resolve({
          cloudinaryPublicId: result.public_id,
          secureUrl: result.secure_url,
          size: result.bytes,
          format: result.format,
          ...(result.width !== undefined ? { width: result.width } : {}),
          ...(result.height !== undefined ? { height: result.height } : {}),
        });
      },
    );

    stream.end(input);
  });
};


export interface CloudinaryDocumentUploadResult {
  cloudinaryPublicId: string;
  secureUrl: string;
  size: number;
  format: string;
}

/**
 * Uploads a text document (Buffer, string, or file path) directly to Cloudinary
 * using resource_type "raw" to securely store text, markdown, json, or csv.
 */
export const uploadDocumentToCloudinary = async (
  input: Buffer | string,
  options?: CloudinaryUploadOptions,
): Promise<CloudinaryDocumentUploadResult> => {
  const uploadOptions: Record<string, unknown> = {
    resource_type: "raw",
    folder: options?.folder ?? "nexamind/attachments/documents",
    ...(options?.publicId ? { public_id: options.publicId } : {}),
    ...(options?.tags ? { tags: options.tags } : {}),
  };

  if (typeof input === "string") {
    try {
      const result: UploadApiResponse = await cloudinary.uploader.upload(
        input,
        uploadOptions,
      );

      return {
        cloudinaryPublicId: result.public_id,
        secureUrl: result.secure_url,
        size: result.bytes,
        format: result.format,
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Cloudinary document upload failed";
      throw new AppError(
        `Failed to upload document to Cloudinary: ${message}`,
        502,
        "CLOUDINARY_UPLOAD_FAILED",
      );
    }
  }

  return new Promise<CloudinaryDocumentUploadResult>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error || !result) {
          return reject(
            new AppError(
              `Failed to upload document to Cloudinary: ${error?.message ?? "Upload failed"}`,
              502,
              "CLOUDINARY_UPLOAD_FAILED",
            ),
          );
        }

        resolve({
          cloudinaryPublicId: result.public_id,
          secureUrl: result.secure_url,
          size: result.bytes,
          format: result.format,
        });
      },
    );

    stream.end(input);
  });
};

/**
 * Deletes any file (image or raw document) from Cloudinary by its public ID.
 */
export const deleteFileFromCloudinary = async (
  publicId: string,
  resourceType: "image" | "raw" | "auto" = "image",
): Promise<{ result: string }> => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
    });
    return result as { result: string };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Cloudinary deletion failed";
    throw new AppError(
      `Failed to delete asset from Cloudinary: ${message}`,
      502,
      "CLOUDINARY_DELETE_FAILED",
    );
  }
};

/**
 * Deletes an image from Cloudinary by its public ID.
 */
export const deleteImageFromCloudinary = async (
  publicId: string,
  resourceType: "image" | "raw" | "auto" = "image",
): Promise<{ result: string }> => {
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
    });
    return result as { result: string };
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Cloudinary deletion failed";
    throw new AppError(
      `Failed to delete image from Cloudinary: ${message}`,
      502,
      "CLOUDINARY_DELETE_FAILED",
    );
  }
};

export { cloudinary };
