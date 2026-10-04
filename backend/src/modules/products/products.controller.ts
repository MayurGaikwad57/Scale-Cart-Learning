import type { Request, Response } from "express";
import { idParams } from "../../utils/validation.js";
import { productsService } from "./products.service.js";
import { listQuerySchema } from "./products.validation.js";

const isAdmin = (req: Request) => req.user?.role === "ADMIN";

export const productsController = {
  // Express 5 makes req.query read-only, so the query is parsed here instead of in middleware.
  async list(req: Request, res: Response) {
    res.json(await productsService.list(listQuerySchema.parse(req.query), isAdmin(req)));
  },
  async categories(_req: Request, res: Response) {
    res.json(await productsService.categories());
  },
  async get(req: Request, res: Response) {
    const { id } = idParams.parse(req.params);
    res.json(await productsService.get(id, isAdmin(req)));
  },
  async create(req: Request, res: Response) {
    res.status(201).json(await productsService.create(req.body));
  },
  async update(req: Request, res: Response) {
    const { id } = idParams.parse(req.params);
    res.json(await productsService.update(id, req.body));
  },
  async remove(req: Request, res: Response) {
    const { id } = idParams.parse(req.params);
    await productsService.remove(id);
    res.status(204).end();
  },
};
