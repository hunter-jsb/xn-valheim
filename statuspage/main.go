package main

import (
	"github.com/pulumi/pulumi-terraform-provider/sdks/go/statuspage/statuspage"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		cfg := config.New(ctx, "")
		pageID := cfg.Require("pageId")

		server, err := statuspage.NewComponent(ctx, "valheim-server", &statuspage.ComponentArgs{
			PageId:      pulumi.String(pageID),
			Name:        pulumi.String("Valheim Server"),
			Description: pulumi.String("Valheim 1.0 (Deep North) dedicated server — Mothership"),
			Showcase:    pulumi.Bool(true),
		})
		if err != nil {
			return err
		}

		webmap, err := statuspage.NewComponent(ctx, "valheim-webmap", &statuspage.ComponentArgs{
			PageId:      pulumi.String(pageID),
			Name:        pulumi.String("World Map"),
			Description: pulumi.String("Live web map (WebMap mod)"),
			Showcase:    pulumi.Bool(true),
		})
		if err != nil {
			return err
		}

		ctx.Export("serverComponentId", server.ID())
		ctx.Export("webmapComponentId", webmap.ID())
		return nil
	})
}
