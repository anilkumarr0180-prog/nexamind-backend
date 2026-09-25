import { Types } from "mongoose";
import { Attachment } from "./attachment.model.js";
import type {
  CreateAttachmentData,
  IAttachment,
  UpdateAttachmentData,
} from "./attachment.types.js";

export const createAttachment = async (
  data: CreateAttachmentData,
): Promise<IAttachment> => {
  return Attachment.create(data as any);
};

export const findAttachmentById = async (
  attachmentId: string | Types.ObjectId,
): Promise<IAttachment | null> => {
  return Attachment.findById(attachmentId);
};

export const findAttachmentByIdAndUserId = async (
  attachmentId: string | Types.ObjectId,
  userId: string | Types.ObjectId,
): Promise<IAttachment | null> => {
  return Attachment.findOne({
    _id: attachmentId,
    userId,
  });
};

export const findAttachmentsByConversationId = async (
  conversationId: string | Types.ObjectId,
  userId: string | Types.ObjectId,
): Promise<IAttachment[]> => {
  return Attachment.find({
    conversationId,
    userId,
  }).sort({ createdAt: 1 });
};

export const findAttachmentByCloudinaryPublicId = async (
  cloudinaryPublicId: string,
): Promise<IAttachment | null> => {
  return Attachment.findOne({
    cloudinaryPublicId,
  });
};

export const updateAttachment = async (
  attachmentId: string | Types.ObjectId,
  data: UpdateAttachmentData,
): Promise<IAttachment | null> => {
  return Attachment.findByIdAndUpdate(
    attachmentId,
    { $set: data },
    { returnDocument: "after", runValidators: true },
  );
};

export const deleteAttachmentById = async (
  attachmentId: string | Types.ObjectId,
): Promise<IAttachment | null> => {
  return Attachment.findByIdAndDelete(attachmentId);
};
