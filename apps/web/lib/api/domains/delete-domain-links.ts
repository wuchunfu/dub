import { qstash } from "@/lib/cron";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/upstash";
import { APP_DOMAIN_WITH_NGROK, R2_URL } from "@dub/utils";
import { storage } from "../../storage";
import { recordLink } from "../../tinybird";
import { removeDomainFromVercel } from "./remove-domain-vercel";

// Delete a domain and all links & images associated with it
export async function deleteDomainAndLinks({
  domain,
  workspaceId,
}: {
  domain: string;
  workspaceId: string;
}) {
  const links = await prisma.link.findMany({
    where: {
      domain,
    },
    include: {
      tags: true,
    },
    take: 1,
  });

  if (links.length === 0) {
    return;
  }

  const pipeline = redis.pipeline();

  links.forEach((link) => {
    pipeline.del(`${link.domain}:${link.key}`.toLowerCase());
  });

  const response = await Promise.allSettled([
    // Record link in the Tinybird
    recordLink(
      links.map((link) => ({
        link_id: link.id,
        domain: link.domain,
        key: link.key,
        url: link.url,
        tag_ids: link.tags.map((tag) => tag.id),
        workspace_id: workspaceId,
        created_at: link.createdAt,
        deleted: true,
      })),
    ),

    // Remove image from R2 storage if it exists
    links
      .filter((link) => link.image?.startsWith(`${R2_URL}/images/${link.id}`))
      .map((link) => storage.delete(link.image!.replace(`${R2_URL}/`, ""))),

    // Remove the link from Redis
    pipeline.exec(),

    // Remove the link from MySQL
    prisma.link.deleteMany({
      where: {
        id: { in: links.map((link) => link.id) },
      },
    }),

    // Decrement the links count for the workspace
    prisma.project.update({
      where: {
        id: workspaceId,
      },
      data: {
        linksUsage: {
          decrement: links.length,
        },
      },
    }),
  ]);

  response.forEach((promise) => {
    if (promise.status === "rejected") {
      console.error("Error deleting domain and links", {
        reason: promise.reason,
        domain,
        workspaceId,
      });
    }
  });

  const remainingLinks = await prisma.link.count({
    where: {
      domain,
    },
  });

  if (remainingLinks > 0) {
    return await queueDomainDeletion({
      workspaceId,
      domain,
      delay: 2,
    });
  }

  // After all links are deleted, delete the domain
  await prisma.domain.delete({
    where: {
      slug: domain,
    },
  });
}

// Mark the domain as deleted
// We'll delete the domain and its links via a cron job
export async function markDomainAsDeleted({
  domain,
  workspaceId,
}: {
  domain: string;
  workspaceId: string;
}) {
  const [vercelResponse, prismaResponse, qstashResponse] =
    await Promise.allSettled([
      removeDomainFromVercel(domain),

      prisma.domain.update({
        where: {
          slug: domain,
        },
        data: {
          projectId: null,
        },
      }),

      prisma.link.updateMany({
        where: {
          domain,
        },
        data: {
          projectId: null,
        },
      }),

      queueDomainDeletion({
        workspaceId,
        domain,
      }),
    ]);

  if (vercelResponse.status === "rejected") {
    console.error("Error deleting domain from Vercel", {
      reason: vercelResponse.reason,
      domain,
      workspaceId,
    });
  }

  if (prismaResponse.status === "rejected") {
    console.error("Error deleting domain from Prisma", {
      reason: prismaResponse.reason,
      domain,
      workspaceId,
    });
  }

  if (qstashResponse.status === "rejected") {
    console.error("Error publishing to Qstash", {
      reason: qstashResponse.reason,
      domain,
      workspaceId,
    });
  }
}

async function queueDomainDeletion({
  workspaceId,
  domain,
  delay,
}: {
  workspaceId: string;
  domain: string;
  delay?: number;
}) {
  return await qstash.publishJSON({
    url: `${APP_DOMAIN_WITH_NGROK}/api/cron/domains/delete`,
    ...(delay && { delay }),
    body: {
      workspaceId,
      domain,
    },
  });
}
