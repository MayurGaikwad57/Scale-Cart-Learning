# ScaleCart

Distributed order-processing platform: modular monolith evolving into microservices.
See `project-plan.md` for the roadmap.

- `backend/` Node + Express + TypeScript + Prisma + PostgreSQL
- `frontend/` Angular (standalone, signals)

## Run locally
```
cd backend && cp .env.example .env   # fill in DATABASE_URL
npm install && npx prisma migrate deploy && npm run dev
cd frontend && npm install && npm start
```
