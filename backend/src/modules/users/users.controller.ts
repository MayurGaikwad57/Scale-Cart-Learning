import type { Request, Response } from "express";
import { usersService } from "./users.service.js";

export const usersController = {
  async register(req: Request, res: Response) {
    res.status(201).json(await usersService.register(req.body));
  },
  async login(req: Request, res: Response) {
    res.json(await usersService.login(req.body));
  },
  async me(req: Request, res: Response) {
    res.json({ user: await usersService.me(req.user!.id) });
  },
};
