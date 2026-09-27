"use client";

import { UserButton } from "@clerk/nextjs";
import { Shirt } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { useCurrentUser } from "@/hooks/use-current-user";
import { routes } from "@/lib/routes";
import { isActivePath, PRIMARY_NAV, SECONDARY_NAV, type NavItem } from "./nav-items";

export function AppSidebar() {
  const pathname = usePathname();
  const { user } = useCurrentUser();
  const isAdmin = user?.role === "admin";
  // Nothing in the app works before onboarding finishes, so the links stay away until it does.
  const onboarded = Boolean(user?.onboardedAt);

  const renderItem = (item: NavItem) => (
    <SidebarMenuItem key={item.href}>
      <SidebarMenuButton
        render={<Link href={item.href} />}
        isActive={isActivePath(pathname, item.href)}
        tooltip={item.label}
        className="h-11 rounded-full px-4 text-sm group-data-[collapsible=icon]:px-2! data-active:bg-sidebar-primary data-active:text-sidebar-primary-foreground"
      >
        <item.icon />
        <span>{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-4 py-5 group-data-[collapsible=icon]:px-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<Link href={routes.wardrobe} />} size="lg" tooltip="Fitcheck">
              <span className="flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Shirt className="size-4" />
              </span>
              <span className="text-xl font-semibold tracking-tight">Fitcheck</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {onboarded ? (
          <>
            <SidebarGroup className="px-3 group-data-[collapsible=icon]:px-2">
              <SidebarGroupContent>
                <SidebarMenu className="gap-1.5">{PRIMARY_NAV.map(renderItem)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup className="mt-5 px-3 group-data-[collapsible=icon]:px-2">
              <SidebarGroupLabel>Account</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>{SECONDARY_NAV.filter((item) => !item.adminOnly || isAdmin).map(renderItem)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </>
        ) : null}
      </SidebarContent>
      <SidebarFooter className="border-t p-4 group-data-[collapsible=icon]:px-2">
        <div className="flex items-center gap-3 group-data-[collapsible=icon]:justify-center">
          <UserButton appearance={{ elements: { avatarBox: "size-7" } }} />
          <div className="min-w-0 text-xs group-data-[collapsible=icon]:hidden">
            <div className="truncate font-medium">{user?.name ?? "Your account"}</div>
            <div className="truncate text-muted-foreground">Personal wardrobe</div>
          </div>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
