import { Router } from "express";
import * as attachmentController from "./attachment.controller.js";
import { authenticate } from "../../middleware/auth.js";
import { uploadSingleImage, uploadSingleDocument } from "../../middleware/upload.js";

const router = Router();

router.use(authenticate);

router.post(
  "/image",
  uploadSingleImage,
  attachmentController.uploadImageAttachment,
);

router.post(
  "/document",
  uploadSingleDocument,
  attachmentController.uploadDocumentAttachment,
);

router.delete(
  "/:attachmentId",
  attachmentController.deleteAttachment,
);

export default router;
