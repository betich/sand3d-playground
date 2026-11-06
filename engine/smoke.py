import sand3d as s3d
def build():
    plate = s3d.extrude("plate", s3d.rect(80, 40, r=4), 6)
    s3d.hole(plate, 6.6, on=s3d.grid(2, 1, 50, 0))
    return plate
