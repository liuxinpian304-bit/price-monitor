import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Request, Response } from "express";

import { Roles } from "../auth/roles.guard.ts";
import type { CreateCatalogModelInput, UpdateCatalogModelInput } from "../catalog/catalog.dto.ts";
import { catalogController, catalogImportController, catalogTemplateService } from "../runtime.ts";
import { requestIdentity } from "./identity.ts";

function respond(response: Response, result: { status: number; body: unknown }) {
  response.status(result.status);
  return result.body;
}

@Controller("catalog")
export class CatalogHttpController {
  @Get("template")
  async downloadTemplate(@Res() response: Response) {
    const template = await catalogTemplateService.getTemplate();
    response.setHeader("content-type", template.contentType);
    response.setHeader(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(template.filename)}`
    );
    response.setHeader("content-length", String(template.buffer.length));
    response.send(template.buffer);
  }

  @Get("models")
  async listModels(@Res({ passthrough: true }) response: Response) {
    return respond(response, await catalogController.getModels());
  }

  @Post("models")
  @Roles("ADMIN")
  async createModel(
    @Body() body: CreateCatalogModelInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return respond(response, await catalogController.postModel(body, requestIdentity(request).actorId));
  }

  @Patch("models/:id")
  @Roles("ADMIN")
  async updateModel(
    @Param("id") id: string,
    @Body() body: UpdateCatalogModelInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return respond(response, await catalogController.patchModel(id, body, requestIdentity(request).actorId));
  }

  @Post("models/:id/toggle")
  @Roles("ADMIN")
  async toggleModel(
    @Param("id") id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response
  ) {
    return respond(response, await catalogController.toggleModel(id, requestIdentity(request).actorId));
  }

  @Get("models/:id/bundles")
  async bundles(@Param("id") id: string, @Res({ passthrough: true }) response: Response) {
    return respond(response, await catalogController.getBundles(id));
  }

  @Get("models/:id/aliases")
  async aliases(@Param("id") id: string, @Res({ passthrough: true }) response: Response) {
    return respond(response, await catalogController.getAliases(id));
  }

  @Post("import")
  @Roles("ADMIN")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 10 * 1024 * 1024 } }))
  async importCatalog(@UploadedFile() file: Express.Multer.File | undefined, @Req() request: Request) {
    return catalogImportController.importCatalog(
      file ? { originalName: file.originalname, buffer: file.buffer } : undefined,
      requestIdentity(request).actorId
    );
  }
}
